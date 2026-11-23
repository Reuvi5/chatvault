'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ImportWizard } from '@/components/ImportWizard';

function ImportPageInner() {
  const params = useSearchParams();
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Import a conversation</h1>
        <p className="muted text-sm leading-relaxed">
          ChatVault cannot reach your messaging account and does not try to. You export a
          conversation yourself, and the file you choose is parsed and encrypted here, on this
          device.
        </p>
      </header>
      <ImportWizard targetConversationId={params.get('conversation')} />
    </main>
  );
}

export default function ImportPage() {
  return (
    <Suspense fallback={null}>
      <ImportPageInner />
    </Suspense>
  );
}
