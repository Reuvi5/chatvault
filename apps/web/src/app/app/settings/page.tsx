'use client';

import { useState } from 'react';
import { assessPassphrase } from '@chatvault/crypto';
import { ApiRequestError } from '@chatvault/client';
import {
  Badge,
  Button,
  Card,
  CopyBlock,
  Field,
  Notice,
  TextInput,
} from '@/components/ui';
import { useVault } from '@/components/VaultProvider';

export default function SettingsPage() {
  const { session, vault, api, changePassphrase, newRecoveryKey, lock, signOut, refreshSession } =
    useVault();

  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [passphraseBusy, setPassphraseBusy] = useState(false);
  const [passphraseNote, setPassphraseNote] = useState<string | null>(null);

  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const [deleteEmail, setDeleteEmail] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assessment = assessPassphrase(passphrase);

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Card className="space-y-2 p-5">
        <h2 className="text-base font-semibold">This account</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="muted text-xs uppercase tracking-wide">Email</dt>
            <dd>{session?.email}</dd>
          </div>
          <div>
            <dt className="muted text-xs uppercase tracking-wide">Archive key</dt>
            <dd className="font-mono text-xs">{vault?.keyId}</dd>
          </div>
          <div>
            <dt className="muted text-xs uppercase tracking-wide">Timezone recorded</dt>
            <dd>{session?.vault?.assumedTimeZone}</dd>
          </div>
          <div>
            <dt className="muted text-xs uppercase tracking-wide">Two-factor</dt>
            <dd>
              {session?.mfaEnabled ? <Badge tone="good">On</Badge> : <Badge tone="warn">Off</Badge>}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">Change your archive passphrase</h2>
        <p className="muted text-sm leading-relaxed">
          This re-wraps the same archive key under a new passphrase. Nothing is re-uploaded and
          nothing already stored changes.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="New passphrase"
            id="newpass"
            error={passphrase && !assessment.ok ? assessment.problems.join(' ') : null}
          >
            <TextInput
              id="newpass"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
          <Field label="Repeat it" id="newpass2">
            <TextInput
              id="newpass2"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
        </div>
        {passphraseNote ? <Notice tone="good">{passphraseNote}</Notice> : null}
        <Button
          busy={passphraseBusy}
          disabled={!assessment.ok || passphrase !== confirmation}
          onClick={async () => {
            setPassphraseBusy(true);
            setError(null);
            setPassphraseNote(null);
            try {
              await changePassphrase(passphrase);
              setPassphrase('');
              setConfirmation('');
              setPassphraseNote('Your passphrase has been changed.');
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'The change did not go through.');
            } finally {
              setPassphraseBusy(false);
            }
          }}
        >
          Change passphrase
        </Button>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">Recovery key</h2>
        <p className="muted text-sm leading-relaxed">
          Issuing a new recovery key invalidates the old one immediately. We never store it, so this
          is the only time the new one is shown.
        </p>
        {recoveryKey ? (
          <>
            <Notice tone="warn">Save this now. The previous recovery key no longer works.</Notice>
            <CopyBlock value={recoveryKey} label="recovery key" />
          </>
        ) : null}
        <Button
          busy={recoveryBusy}
          onClick={async () => {
            setRecoveryBusy(true);
            setError(null);
            try {
              setRecoveryKey(await newRecoveryKey());
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'That did not work.');
            } finally {
              setRecoveryBusy(false);
            }
          }}
        >
          Issue a new recovery key
        </Button>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">Two-factor authentication</h2>
        {session?.mfaEnabled ? (
          <Notice tone="good">
            An authenticator code is required when signing in on this account.
          </Notice>
        ) : totp ? (
          <div className="space-y-3">
            <p className="muted text-sm">
              Add this secret to your authenticator app, then enter the six-digit code it shows.
            </p>
            <CopyBlock value={totp.secret} label="secret" />
            <p className="muted wrap-anywhere font-mono text-xs">{totp.otpauthUrl}</p>
            <Field label="Code from the app" id="code">
              <TextInput
                id="code"
                inputMode="numeric"
                maxLength={6}
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              onClick={async () => {
                setError(null);
                try {
                  const result = await api.confirmTotpEnrollment(totpCode);
                  setRecoveryCodes(result.recoveryCodes);
                  setTotp(null);
                  setTotpCode('');
                  await refreshSession();
                } catch (caught) {
                  setError(
                    caught instanceof ApiRequestError ? caught.message : 'That code was not right.',
                  );
                }
              }}
            >
              Turn on two-factor
            </Button>
          </div>
        ) : (
          <Button
            onClick={async () => {
              setError(null);
              try {
                setTotp(await api.beginTotpEnrollment());
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'That did not work.');
              }
            }}
          >
            Set up an authenticator app
          </Button>
        )}
        {recoveryCodes ? (
          <>
            <Notice tone="warn">
              Save these one-time codes somewhere safe. They are the way back in if you lose your
              authenticator.
            </Notice>
            <CopyBlock value={recoveryCodes.join('\n')} label="codes" />
          </>
        ) : null}
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="text-base font-semibold">This device</h2>
        <p className="muted text-sm leading-relaxed">
          Locking clears the archive key from memory and empties the local cache of encrypted
          objects. It happens automatically after 30 minutes of inactivity, and whenever this tab is
          closed.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void lock()}>Lock now</Button>
          <Button onClick={() => void signOut()}>Sign out</Button>
        </div>
      </Card>

      <Card className="space-y-3 border-danger-400/50 p-5">
        <h2 className="text-base font-semibold text-danger-500">Delete this account</h2>
        <p className="muted text-sm leading-relaxed">
          This schedules deletion of every conversation, both encrypted copies and all metadata.
          There is a retention window first, during which it can still be stopped by contacting
          support; after that it cannot be undone. Your original exports on your own devices are not
          touched.
        </p>
        <Field label="Type your email address to confirm" id="confirm-email">
          <TextInput
            id="confirm-email"
            value={deleteEmail}
            onChange={(event) => setDeleteEmail(event.target.value)}
          />
        </Field>
        <Button
          variant="danger"
          busy={deleteBusy}
          disabled={deleteEmail !== session?.email}
          onClick={async () => {
            if (!window.confirm('Schedule deletion of this account and everything in it?')) return;
            setDeleteBusy(true);
            try {
              await api.deleteAccount(deleteEmail, false);
              await signOut();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'That did not work.');
            } finally {
              setDeleteBusy(false);
            }
          }}
        >
          Schedule deletion
        </Button>
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}
    </main>
  );
}
