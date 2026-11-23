import Link from 'next/link';
import { BYTES_PER_GB, PRICE_USD_PER_GB_MONTH, formatUsd } from '@chatvault/protocol';

const examples = [10, 50, 100, 250] as const;

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-full max-w-5xl flex-col gap-16 px-5 py-14 sm:py-20">
      <header className="space-y-6">
        <p className="muted text-xs font-semibold uppercase tracking-[0.2em]">ChatVault</p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.1] sm:text-5xl">
          Your chat history, preserved.
        </h1>
        <p className="muted max-w-2xl text-lg leading-relaxed">
          A private archive for conversations you have exported yourself. Everything is encrypted on
          your own device before it is uploaded, kept as two independent encrypted copies, and
          readable in a chat view you can search.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-600"
          >
            Create an account
          </Link>
          <Link
            href="/login"
            className="surface rounded-lg border hairline px-4 py-2.5 text-sm font-medium"
          >
            Sign in
          </Link>
        </div>
      </header>

      <section className="grid gap-5 sm:grid-cols-3">
        {[
          {
            title: 'Encrypted before it leaves',
            body: 'Your archive key is derived on your device from a passphrase only you know. The server stores ciphertext and opaque identifiers, and cannot read a message, a name or a photo.',
          },
          {
            title: 'Two independent copies',
            body: 'Every object is stored with a primary provider and copied to a second one under separate credentials. A conversation is only marked verified once both copies check out.',
          },
          {
            title: 'Honest about gaps',
            body: 'An export only contains what the app still had on the device. ChatVault shows you what is missing instead of implying your history is complete.',
          },
        ].map((item) => (
          <article key={item.title} className="surface rounded-card border hairline p-5">
            <h2 className="mb-2 text-base font-semibold">{item.title}</h2>
            <p className="muted text-sm leading-relaxed">{item.body}</p>
          </article>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">Pricing</h2>
        <p className="muted max-w-2xl text-sm leading-relaxed">
          {formatUsd(PRICE_USD_PER_GB_MONTH)} per gigabyte of archive per month, measured by the hour
          and billed once for your data rather than once per copy. A gigabyte means{' '}
          {BYTES_PER_GB.toLocaleString('en-US')} bytes. There is no minimum charge.
        </p>
        <div className="surface overflow-hidden rounded-card border hairline">
          <table className="w-full text-sm">
            <thead className="sunken text-left">
              <tr>
                <th className="px-4 py-2.5 font-medium">Archive size</th>
                <th className="px-4 py-2.5 text-right font-medium">Each month</th>
              </tr>
            </thead>
            <tbody>
              {examples.map((gb) => (
                <tr key={gb} className="border-t hairline">
                  <td className="px-4 py-2.5">{gb} GB</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {formatUsd(gb * PRICE_USD_PER_GB_MONTH)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">What this is not</h2>
        <ul className="muted max-w-2xl space-y-2 text-sm leading-relaxed">
          <li>
            It is not a messaging app. You cannot send or receive messages here, and nothing is
            synced from any account automatically — you export a conversation yourself and import the
            file.
          </li>
          <li>
            It cannot put an archive back into the app it came from, and it does not work around any
            export restriction, including choices other people in a chat have made.
          </li>
          <li>
            It is not a substitute for your own copy. Keep your original export until you have opened
            the archive here and confirmed it reads correctly.
          </li>
        </ul>
      </section>

      <footer className="muted border-t hairline pt-6 text-xs leading-relaxed">
        <p>
          ChatVault is an independent product and is not affiliated with, endorsed by or connected to
          WhatsApp, Meta or any other messaging provider.
        </p>
        <p className="mt-2">
          Strong encryption protects your data from the people running this service and from the
          storage providers. It cannot protect a device that is already compromised, and no hosted
          web application can promise to be impossible to compromise.
        </p>
      </footer>
    </main>
  );
}
