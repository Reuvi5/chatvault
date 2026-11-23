'use client';

/**
 * Creating the archive key (plan §3 "First-time setup").
 *
 * Two things this screen must get right, because they cannot be fixed later:
 *  - the person chooses a passphrase the server never sees, and
 *  - they are shown the offline recovery key once, and have to confirm they
 *    have stored it, with the consequence of losing both stated plainly.
 */
import { useMemo, useState } from 'react';
import { assessPassphrase } from '@chatvault/crypto';
import { Button, Card, CopyBlock, Field, Notice, TextInput } from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

const COMMON_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Athens',
  'Asia/Jerusalem',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

export function SetupVault() {
  const { setupVault } = useVault();
  const detected = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [timeZone, setTimeZone] = useState(detected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const assessment = useMemo(() => assessPassphrase(passphrase), [passphrase]);
  const zones = useMemo(
    () => [...new Set([detected, ...COMMON_ZONES])].filter(Boolean),
    [detected],
  );

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (passphrase !== confirmation) {
      setError('The two passphrases do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await setupVault(passphrase, timeZone);
      setRecoveryKey(result.recoveryKeyDisplay);
      setPassphrase('');
      setConfirmation('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The archive key could not be created.');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryKey) {
    return (
      <main className="mx-auto max-w-xl px-5 py-12">
        <Card className="space-y-5 p-6">
          <h1 className="text-xl font-semibold">Save your recovery key</h1>
          <Notice tone="warn" title="This is shown once and is not stored anywhere">
            <p>
              If you forget your passphrase, this key is the only way back into your archive. We
              cannot reset it, recover it or read your archive without it.
            </p>
            <p>Write it down or put it in a password manager before you continue.</p>
          </Notice>
          <CopyBlock value={recoveryKey} label="recovery key" />
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I have stored this recovery key somewhere safe, and I understand that losing both it
              and my passphrase means the archive cannot be opened by anyone, including you.
            </span>
          </label>
          <Button
            variant="primary"
            disabled={!acknowledged}
            onClick={() => window.location.assign('/app')}
          >
            Continue to my archive
          </Button>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-5 py-12">
      <Card className="space-y-5 p-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Set up your archive key</h1>
          <p className="muted text-sm leading-relaxed">
            This passphrase derives the key that encrypts everything before it is uploaded. It is not
            your sign-in password, and it never reaches the server.
          </p>
        </div>

        <form onSubmit={create} className="space-y-4">
          <Field
            label="Archive passphrase"
            id="passphrase"
            hint={
              passphrase
                ? `Roughly ${String(assessment.estimatedBits)} bits of guessing resistance. ${assessment.suggestions.join(' ')}`
                : 'Four or five unrelated words are easy to remember and hard to guess.'
            }
            error={passphrase && !assessment.ok ? assessment.problems.join(' ') : null}
          >
            <TextInput
              id="passphrase"
              type="password"
              autoComplete="new-password"
              required
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>

          <Field label="Repeat the passphrase" id="confirm">
            <TextInput
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>

          <Field
            label="Timezone for displaying times"
            id="tz"
            hint="Exports do not record a timezone. Times are stored exactly as the export wrote them; this setting is only recorded alongside them."
          >
            <select
              id="tz"
              className="sunken w-full rounded-lg border hairline px-3 py-2 text-sm"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                  {zone === detected ? ' (detected)' : ''}
                </option>
              ))}
            </select>
          </Field>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!assessment.ok}
            className="w-full"
          >
            Create my archive key
          </Button>
          <p className="muted text-xs">
            Deriving the key takes a moment: it is deliberately slow, so that guessing it in bulk is
            expensive.
          </p>
        </form>
      </Card>
    </main>
  );
}
