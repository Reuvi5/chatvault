'use client';

/* eslint-disable jsx-a11y/no-autofocus --
   The unlock screen exists to take one value, so focusing that field saves
   every reader a keystroke and disorients nobody. */

import { useState } from 'react';
import { Button, Card, Field, Notice, TextInput } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

export function UnlockVault() {
  const { unlock, session, signOut } = useVault();
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(secret, mode);
      setSecret('');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'That did not unlock the archive. Check it and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <Card className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Unlock your archive</h1>
          <p className="muted text-sm">
            Signed in as {session?.email}. Your archive is encrypted, so it needs your passphrase
            before anything can be read.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          {mode === 'passphrase' ? (
            <Field label="Archive passphrase" id="secret">
              <TextInput
                id="secret"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </Field>
          ) : (
            <Field
              label="Recovery key"
              id="secret"
              hint="The CV1- key you saved when you set the archive up. Spacing and capitalisation do not matter."
            >
              <TextInput
                id="secret"
                required
                autoFocus
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </Field>
          )}

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button type="submit" variant="primary" busy={busy} className="w-full">
            Unlock
          </Button>
        </form>

        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            className="underline"
            onClick={() => {
              setMode(mode === 'passphrase' ? 'recovery' : 'passphrase');
              setSecret('');
              setError(null);
            }}
          >
            {mode === 'passphrase' ? 'Use my recovery key instead' : 'Use my passphrase instead'}
          </button>
          <button type="button" className="muted underline" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </Card>
    </main>
  );
}
