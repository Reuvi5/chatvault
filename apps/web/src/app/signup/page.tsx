'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiClient, ApiRequestError } from '@chatvault/client';
import { Button, Card, Field, Notice, TextInput } from '@/components/ui';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const api = new ApiClient();
      const result = await api.signup(email, password);
      if (result.verificationUrl) {
        setVerificationUrl(result.verificationUrl);
      } else {
        router.push('/app');
      }
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (verificationUrl) {
    return (
      <main className="mx-auto max-w-md px-5 py-16">
        <Card className="space-y-4 p-6">
          <h1 className="text-xl font-semibold">Confirm your email address</h1>
          <Notice tone="accent">
            <p>
              No email provider is configured on this deployment, so the confirmation link is shown
              here instead of being sent.
            </p>
          </Notice>
          <Link
            href={verificationUrl.replace(/^https?:\/\/[^/]+/u, '')}
            className="inline-flex rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-600"
          >
            Confirm this address
          </Link>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <Card className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Create an account</h1>
          <p className="muted text-sm">
            This password signs you in. Your archive gets a separate passphrase that never reaches
            the server.
          </p>
        </div>

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
          <Field
            label="Password"
            id="password"
            hint="At least 12 characters. A short sentence works well."
          >
            <TextInput
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button type="submit" variant="primary" busy={busy} className="w-full">
            Create account
          </Button>
        </form>

        <p className="muted text-sm">
          Already have an account?{' '}
          <Link href="/login" className="underline">
            Sign in
          </Link>
          .
        </p>
      </Card>
    </main>
  );
}
