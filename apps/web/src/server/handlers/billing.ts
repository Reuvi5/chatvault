/**
 * Billing routes. All of them answer honestly when Stripe is not configured.
 */
import { checkoutRequest } from '@chatvault/protocol';
import { getStore } from '../db/index';
import { jsonResponse, parseBody } from '../http';
import { requireSession } from '../auth/session';
import {
  billingConfigured,
  createCheckoutSession,
  createPortalSession,
  handleWebhook,
} from '../services/billing';

export async function handleCheckout(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  const input = await parseBody(request, checkoutRequest);
  const store = await getStore();
  return jsonResponse(await createCheckoutSession(store, account, input.returnPath));
}

export async function handlePortal(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  const input = await parseBody(request, checkoutRequest);
  const store = await getStore();
  return jsonResponse(await createPortalSession(store, account, input.returnPath));
}

export async function handleBillingWebhook(request: Request): Promise<Response> {
  // The raw body is required: the signature covers the exact bytes Stripe sent.
  const rawBody = await request.text();
  const store = await getStore();
  const result = await handleWebhook(store, rawBody, request.headers.get('stripe-signature'));
  return jsonResponse(result);
}

export async function handleBillingStatus(request: Request): Promise<Response> {
  const { account } = await requireSession(request);
  return jsonResponse({
    configured: billingConfigured(),
    status: billingConfigured() ? account.billing_status : 'unconfigured',
    hasCustomer: Boolean(account.stripe_customer_id),
  });
}
