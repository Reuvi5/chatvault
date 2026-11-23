'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiClient, ApiRequestError } from '@chatvault/client';
import { Button, Card, Field, Notice, TextInput } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const api = new ApiClient();
      await api.login(email, password, needsTotp ? totp : undefined);
      router.push('/app');
    } catch (caught) {
      if (
        caught instanceof ApiRequestError &&
        (caught.details as { mfaRequired?: boolean } | undefined)?.mfaRequired
      ) {
        setNeedsTotp(true);
        setError(caught.message);
      } else {
        setError(
          caught instanceof ApiRequestError ? caught.message : 'Something went wrong. Try again.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <Card className="space-y-5 p-6">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email address" id="email">
            <TextInput
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Password" id="password">
            <TextInput
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {needsTotp ? (
            <Field label="Authenticator code" id="totp" hint="Six digits from your authenticator app.">
              <TextInput
                id="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                value={totp}
                onChange={(event) => setTotp(event.target.value)}
              />
            </Field>
          ) : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button type="submit" variant="primary" busy={busy} className="w-full">
            Sign in
          </Button>
        </form>
        <p className="muted text-sm">
          No account yet?{' '}
          <Link href="/signup" className="underline">
            Create one
          </Link>
          .
        </p>
      </Card>
    </main>
  );
}
