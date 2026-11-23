'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { SetupVault } from '@/components/SetupVault';
import { UnlockVault } from '@/components/UnlockVault';
import { VaultProvider, useVault } from '@/components/VaultProvider';
import { Notice, Spinner } from '@/components/ui';

function VerifyBanner() {
  const { session, api, refreshSession } = useVault();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session || session.emailVerified) return null;

  const resend = async () => {
    setBusy(true);
    try {
      const result = await api.resendVerification();
      setUrl(result.verificationUrl ?? null);
      await refreshSession();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      <Notice tone="warn" title="Confirm your email address">
        <p>Importing is disabled until the address on this account is confirmed.</p>
        {url ? (
          <p>
            <Link href={url.replace(/^https?:\/\/[^/]+/u, '')} className="underline">
              Open the confirmation link
            </Link>
          </p>
        ) : (
          <button type="button" className="underline" disabled={busy} onClick={() => void resend()}>
            {busy ? 'Sending…' : 'Send a new confirmation link'}
          </button>
        )}
      </Notice>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { status } = useVault();
  const router = useRouter();

  useEffect(() => {
    if (status === 'signed-out') router.replace('/login');
  }, [status, router]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2">
        <Spinner />
        <span className="muted text-sm">Loading…</span>
      </div>
    );
  }
  if (status === 'signed-out') return null;
  if (status === 'needs-setup') return <SetupVault />;
  if (status === 'locked') return <UnlockVault />;

  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <VerifyBanner />
      <div className="flex-1">{children}</div>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <VaultProvider>
      <Shell>{children}</Shell>
    </VaultProvider>
  );
}
