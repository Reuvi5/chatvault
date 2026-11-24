/**
 * Generate synthetic export fixtures.
 *
 *   npm run fixtures
 *
 * Writes a set of exports to ./fixtures-generated. Everything is invented by
 * `packages/parser/src/synthetic.ts`: no real conversation is involved, which is
 * what plan milestone 0 asks for ("consented/synthetic sample exports").
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildMaliciousArchive, buildSyntheticExport, parseTranscript } from '@chatvault/parser';

const OUT = resolve(process.env.FIXTURE_DIR ?? 'fixtures-generated');

const CASES = [
  {
    name: 'ios-1to1-with-media',
    options: { platform: 'ios', withMedia: true, group: false, messageCount: 90 },
  },
  {
    name: 'ios-group-with-media',
    options: { platform: 'ios', withMedia: true, group: true, messageCount: 90 },
  },
  {
    name: 'ios-1to1-no-media',
    options: { platform: 'ios', withMedia: false, group: false, messageCount: 90 },
  },
  {
    name: 'android-group-with-media',
    options: { platform: 'android', withMedia: true, group: true, messageCount: 90 },
  },
  {
    name: 'android-us-dates-no-media',
    options: {
      platform: 'android',
      withMedia: false,
      dateOrder: 'mdy',
      clock: '12h',
      messageCount: 140,
    },
  },
  {
    // Short, and every date component is 12 or lower, so the order genuinely
    // cannot be determined. Use it to exercise the preview's date-order
    // override.
    name: 'ambiguous-dates-no-media',
    options: {
      platform: 'android',
      withMedia: false,
      messageCount: 12,
      startDate: { year: 2026, month: 5, day: 2 },
    },
  },
  {
    name: 'large-ios-group',
    options: { platform: 'ios', withMedia: true, group: true, messageCount: 2500 },
  },
] as const;

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const rows: string[] = [];

  for (const testCase of CASES) {
    const fixture = buildSyntheticExport({ ...testCase.options, seed: 4242 });
    const fileName = `${testCase.name}.${fixture.kind}`;
    await writeFile(join(OUT, fileName), fixture.bytes);
    const parsed = parseTranscript(fixture.transcript);
    rows.push(
      [
        fileName.padEnd(34),
        `${String(parsed.counts.total).padStart(6)} messages`,
        `${String(fixture.mediaFileNames.length).padStart(3)} attachments`,
        `${(fixture.bytes.byteLength / 1_000_000).toFixed(2).padStart(7)} MB`,
        parsed.dateOrder,
        parsed.dateOrderConfidence,
      ].join('  '),
    );
  }

  for (const variant of ['traversal', 'bomb', 'many_entries'] as const) {
    const bytes = buildMaliciousArchive(variant);
    await writeFile(join(OUT, `hostile-${variant}.zip`), bytes);
    rows.push(`hostile-${variant}.zip`.padEnd(34) + '  (import safety test fixture)');
  }

  console.log(`Fixtures written to ${OUT}\n`);
  for (const row of rows) console.log(row);
  console.log(
    '\nThese are synthetic. Import one through the app to see the whole pipeline end to end.',
  );
}

void main();
