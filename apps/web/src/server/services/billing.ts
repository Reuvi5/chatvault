/**
 * Stripe billing (plan §9, §10).
 *
 * Usage-based, metered on logical GB-months. The integration is real but
 * **gated**: with no `STRIPE_SECRET_KEY` the routes answer "not configured"
 * instead of pretending, so the whole product runs locally without a Stripe
 * account.
 *
 * Nothing here ever sees chat content. What goes to Stripe is an account
 * identifier, an email address and a number of GB-months.
 */
import Stripe from 'stripe';
import { monthKey, formatUsd } from '@chatvault/protocol';
import { getEnv } from '../env';
import type { RowOf, Store } from '../db/index';
import { badRequest, notConfigured } from '../http';
import { log } from '../log';
import { recordAudit } from '../security';
import { accrueBillingPeriod } from './metering';

let client: Stripe | null = null;

export function billingConfigured(): boolean {
  return Boolean(getEnv().billing.stripeSecretKey);
}

function stripe(): Stripe {
  const { billing } = getEnv();
  if (!billing.stripeSecretKey) {
    throw notConfigured(
      'Billing is not configured on this deployment. Set STRIPE_SECRET_KEY to enable it.',
    );
  }
  client ??= new Stripe(billing.stripeSecretKey, { maxNetworkRetries: 2 });
  return client;
}

export async function ensureCustomer(
  store: Store,
  account: RowOf<'accounts'>,
): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const customer = await stripe().customers.create({
    email: account.email,
    metadata: { chatvault_account_id: account.id },
  });
  await store.update('accounts', account.id, {
    stripe_customer_id: customer.id,
    updated_at_ms: Date.now(),
  });
  return customer.id;
}

export async function createCheckoutSession(
  store: Store,
  account: RowOf<'accounts'>,
  returnPath: string,
): Promise<{ url: string }> {
  const env = getEnv();
  if (!env.billing.stripePriceId) {
    throw notConfigured('Set STRIPE_PRICE_ID to the metered price for storage before taking payments.');
  }
  const customerId = await ensureCustomer(store, account);
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: env.billing.stripePriceId }],
    success_url: `${env.appUrl}${returnPath}?billing=ok`,
    cancel_url: `${env.appUrl}${returnPath}?billing=cancelled`,
    client_reference_id: account.id,
  });
  if (!session.url) throw badRequest('Stripe did not return a checkout URL.');
  return { url: session.url };
}

export async function createPortalSession(
  store: Store,
  account: RowOf<'accounts'>,
  returnPath: string,
): Promise<{ url: string }> {
  const env = getEnv();
  const customerId = await ensureCustomer(store, account);
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.appUrl}${returnPath}`,
  });
  return { url: session.url };
}

/**
 * Report accrued GB-months as a meter event.
 *
 * Reporting the *delta* keeps the meter correct if the job runs more than once
 * in a period, which is why `reported_cents` is stored.
 */
export async function reportUsage(
  store: Store,
  accountId: string,
  nowMs = Date.now(),
): Promise<{ reported: boolean; gbMonths: number; detail: string }> {
  const env = getEnv();
  const period = await accrueBillingPeriod(store, accountId, nowMs);
  if (!billingConfigured()) {
    return { reported: false, gbMonths: period.gb_months, detail: 'billing is not configured' };
  }
  const account = await store.get('accounts', accountId);
  if (!account?.stripe_customer_id) {
    return { reported: false, gbMonths: period.gb_months, detail: 'no Stripe customer yet' };
  }
  const deltaCents = period.accrued_cents - period.reported_cents;
  if (deltaCents <= 0) {
    return { reported: false, gbMonths: period.gb_months, detail: 'nothing new to report' };
  }

  const deltaGbMonths = deltaCents / 100 / env.billing.pricePerGbMonth;
  await stripe().billing.meterEvents.create({
    event_name: env.billing.stripeMeterEventName,
    payload: {
      stripe_customer_id: account.stripe_customer_id,
      value: deltaGbMonths.toFixed(6),
    },
    identifier: `${accountId}-${monthKey(nowMs)}-${String(period.accrued_cents)}`,
  });
  await store.update('billing_periods', period.id, {
    reported_cents: period.accrued_cents,
    updated_at_ms: nowMs,
  });
  return {
    reported: true,
    gbMonths: deltaGbMonths,
    detail: `reported ${formatUsd(deltaCents / 100)} of new usage`,
  };
}

/**
 * Webhook handling. The signature is verified against the raw body; an
 * unverified webhook is rejected, never trusted (plan §10).
 */
export async function handleWebhook(
  store: Store,
  rawBody: string,
  signature: string | null,
): Promise<{ handled: string }> {
  const env = getEnv();
  if (!env.billing.stripeWebhookSecret) {
    throw notConfigured('Set STRIPE_WEBHOOK_SECRET before pointing Stripe at this endpoint.');
  }
  if (!signature) throw badRequest('Missing Stripe signature header.');

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, env.billing.stripeWebhookSecret);
  } catch (error) {
    log.warn('Rejected a Stripe webhook with a bad signature');
    throw badRequest(`Webhook signature verification failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }

  const customerIdOf = (object: unknown): string | null => {
    const candidate = (object as { customer?: string | { id?: string } } | null)?.customer;
    if (typeof candidate === 'string') return candidate;
    return candidate?.id ?? null;
  };

  const statusFor = (status: string): string => {
    if (['active', 'trialing'].includes(status)) return 'active';
    if (['past_due', 'unpaid', 'incomplete'].includes(status)) return 'past_due';
    if (['canceled', 'incomplete_expired'].includes(status)) return 'canceled';
    return 'none';
  };

  switch (event.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const object = event.data.object as { status?: string };
      const customerId = customerIdOf(event.data.object);
      if (customerId) {
        const account = await store.findOne('accounts', {
          equals: { stripe_customer_id: customerId },
        });
        if (account) {
          const status =
            event.type === 'customer.subscription.deleted'
              ? 'canceled'
              : statusFor(object.status ?? 'active');
          await store.update('accounts', account.id, {
            billing_status: status,
            updated_at_ms: Date.now(),
          });
          await recordAudit(store, {
            accountId: account.id,
            kind: 'billing.updated',
            detail: `${event.type} -> ${status}`,
          });
        }
      }
      break;
    }
    case 'invoice.payment_failed': {
      const customerId = customerIdOf(event.data.object);
      if (customerId) {
        const account = await store.findOne('accounts', {
          equals: { stripe_customer_id: customerId },
        });
        if (account) {
          await store.update('accounts', account.id, {
            billing_status: 'past_due',
            updated_at_ms: Date.now(),
          });
        }
      }
      break;
    }
    default:
      break;
  }

  return { handled: event.type };
}

/** Called by the worker: accrue and report usage for every active account. */
export async function runBillingCycle(
  store: Store,
  accountIds: readonly string[],
  nowMs = Date.now(),
): Promise<{ accounts: number; reported: number }> {
  let reported = 0;
  for (const accountId of accountIds) {
    try {
      const result = await reportUsage(store, accountId, nowMs);
      if (result.reported) reported += 1;
    } catch (error) {
      log.error('Could not report usage for an account', { accountId, error });
    }
  }
  return { accounts: accountIds.length, reported };
}
