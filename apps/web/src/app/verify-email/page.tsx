'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiClient, ApiRequestError } from '@chatvault/client';
import { Card, Notice, Spinner } from '@/components/ui';

function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setState('error');
      setMessage('That link is missing its confirmation code.');
      return;
    }
    const api = new ApiClient();
    api
      .verifyEmail(token)
      .then(() => setState('done'))
      .catch((error: unknown) => {
        setState('error');
        setMessage(
          error instanceof ApiRequestError ? error.message : 'That link could not be confirmed.',
        );
      });
  }, [token]);

  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <Card className="space-y-4 p-6">
        <h1 className="text-xl font-semibold">Confirming your email address</h1>
        {state === 'working' ? (
          <p className="muted flex items-center gap-2 text-sm">
            <Spinner /> Checking the link…
          </p>
        ) : null}
        {state === 'done' ? (
          <>
            <Notice tone="good">Your email address is confirmed.</Notice>
            <Link
              href="/app"
              className="inline-flex rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-600"
            >
              Open your archive
            </Link>
          </>
        ) : null}
        {state === 'error' ? (
          <>
            <Notice tone="danger">{message}</Notice>
            <Link href="/app" className="underline">
              Back to the app
            </Link>
          </>
        ) : null}
      </Card>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
