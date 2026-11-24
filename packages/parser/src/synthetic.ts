/**
 * Synthetic export fixtures.
 *
 * Plan milestone 0 asks for **consented or synthetic** sample exports. Nothing
 * in this file comes from a real conversation: transcripts, images and audio are
 * all generated here, deterministically, from a seed. The same generator feeds
 * the test suite, the local demo seed and the restore drill.
 */
import { zipSync, zlibSync } from 'fflate';

/* ------------------------------------------------------------ tiny PRNG */

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/* ------------------------------------------------- minimal PNG encoder */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as PNG requires. A checksum, not a security primitive. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function be32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 4 + body.length);
  return out;
}

export function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r & 0xff;
      raw[offset + 1] = g & 0xff;
      raw[offset + 2] = b & 0xff;
      offset += 3;
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/* -------------------------------------------------- minimal WAV encoder */

export function makeWav(seconds = 1, frequency = 440, sampleRate = 8000): Uint8Array {
  const samples = Math.floor(seconds * sampleRate);
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const envelope = 1 - i / samples;
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.3 * envelope;
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return out;
}

/* ------------------------------------------------------ transcript text */

export type Platform = 'ios' | 'android';

export interface SyntheticExportOptions {
  platform?: Platform;
  /** Day-first (most locales) or month-first (US-style) dates. */
  dateOrder?: 'dmy' | 'mdy';
  clock?: '12h' | '24h';
  withSeconds?: boolean;
  group?: boolean;
  withMedia?: boolean;
  messageCount?: number;
  seed?: number;
  title?: string;
  /** Start of the conversation, as a UTC calendar date. */
  startDate?: { year: number; month: number; day: number };
}

const SMALL_TALK = [
  'Are we still on for Thursday?',
  'Just landed, the queue at passport control is unreal',
  'I found the photo from the lake. Sending it now',
  'Ha! I had completely forgotten about that',
  'Can you send the address again?',
  'Running about ten minutes late, sorry',
  'That recipe worked. The trick was less water',
  'שלום, מה המצב?',
  'مرحبا، كيف حالك؟',
  'Okay 😂😂 that settles it',
  'Reminder: tickets go on sale at nine',
  'My train is cancelled so I will drive instead',
  'Thanks for yesterday, it meant a lot',
  'Look at this view 🏔️',
  'Multi-line incoming:\nfirst the plan\nthen the budget\nthen the part nobody reads',
];

const MEMBERS_1TO1 = ['Dana Okonkwo', 'Sam Reyes'];
const MEMBERS_GROUP = ['Dana Okonkwo', 'Sam Reyes', 'Priya Raman', 'Tomás Oliveira'];

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/**
 * Index one of the fixture lists above.
 *
 * These lists are ours, so an out-of-range index means the generator is
 * misconfigured. Failing loudly says that; a type assertion would only hide it.
 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`Fixture list has no entry at index ${String(index)}`);
  }
  return value;
}

function formatDate(
  date: { year: number; month: number; day: number },
  order: 'dmy' | 'mdy',
): string {
  const d = pad(date.day);
  const m = pad(date.month);
  return order === 'dmy' ? `${d}/${m}/${date.year}` : `${m}/${d}/${date.year}`;
}

function formatTime(
  time: { hour: number; minute: number; second: number },
  clock: '12h' | '24h',
  withSeconds: boolean,
): string {
  if (clock === '24h') {
    return withSeconds
      ? `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`
      : `${pad(time.hour)}:${pad(time.minute)}`;
  }
  const meridiem = time.hour < 12 ? 'AM' : 'PM';
  const hour12 = time.hour % 12 === 0 ? 12 : time.hour % 12;
  const core = withSeconds
    ? `${hour12}:${pad(time.minute)}:${pad(time.second)}`
    : `${hour12}:${pad(time.minute)}`;
  return `${core}\u202f${meridiem}`;
}

export interface SyntheticExport {
  fileName: string;
  /** Archive bytes when media are included, otherwise the transcript. */
  bytes: Uint8Array;
  kind: 'zip' | 'txt';
  transcript: string;
  mediaFileNames: string[];
  expected: {
    title: string;
    participants: string[];
    messageCount: number;
    isGroup: boolean;
  };
}

/**
 * Build one synthetic export.
 *
 * The transcript deliberately contains the awkward cases from the plan's test
 * matrix: multi-line bodies, emoji, right-to-left text, system notices, edited
 * and deleted markers, attachments, and two messages that are identical in the
 * same minute.
 */
export function buildSyntheticExport(options: SyntheticExportOptions = {}): SyntheticExport {
  const platform = options.platform ?? 'ios';
  const order = options.dateOrder ?? 'dmy';
  const clock = options.clock ?? (platform === 'ios' ? '12h' : '24h');
  const withSeconds = options.withSeconds ?? platform === 'ios';
  const group = options.group ?? false;
  const withMedia = options.withMedia ?? true;
  const count = options.messageCount ?? 40;
  const random = lcg(options.seed ?? 20_261_117);
  const members = group ? MEMBERS_GROUP : MEMBERS_1TO1;
  const self = at(members, 0);
  const title = options.title ?? (group ? 'Lake trip planning' : at(members, 1));
  const start = options.startDate ?? { year: 2026, month: 3, day: 7 };

  const mediaFiles: Array<{ name: string; bytes: Uint8Array }> = [];
  const lines: string[] = [];
  let cursor = Date.UTC(start.year, start.month - 1, start.day, 9, 12, 5);

  const header = (atMs: number) => {
    const date = new Date(atMs);
    const d = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
    const t = {
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    };
    const dateText = formatDate(d, order);
    const timeText = formatTime(t, clock, withSeconds);
    return platform === 'ios' ? `\u200e[${dateText}, ${timeText}] ` : `${dateText}, ${timeText} - `;
  };

  const push = (atMs: number, body: string, sender: string | null) => {
    const prefix = header(atMs);
    lines.push(sender === null ? `${prefix}${body}` : `${prefix}${sender}: ${body}`);
  };

  // System notices, as an export opens with.
  push(
    cursor,
    'Messages and calls are end-to-end encrypted. Only people in this chat can read them.',
    null,
  );
  cursor += 60_000;
  if (group) {
    push(cursor, `${self} created group "${title}"`, null);
    cursor += 45_000;
    push(cursor, `${self} added ${members.slice(1).join(', ')}`, null);
    cursor += 120_000;
  }

  for (let i = 0; i < count; i += 1) {
    const sender = at(members, Math.floor(random() * members.length));
    const roll = random();
    cursor += Math.floor(60_000 + random() * 7 * 3_600_000);

    if (withMedia && roll < 0.22) {
      const isAudio = random() < 0.3;
      const index = mediaFiles.length + 1;
      if (isAudio) {
        const name =
          platform === 'ios'
            ? `${pad(index, 8)}-AUDIO-2026-03-${pad(7 + (index % 20))}-WA${pad(index, 4)}.wav`
            : `PTT-20260307-WA${pad(index, 4)}.wav`;
        mediaFiles.push({ name, bytes: makeWav(1 + (index % 3), 320 + index * 40) });
        push(
          cursor,
          platform === 'ios' ? `\u200e<attached: ${name}>` : `${name} (file attached)`,
          sender,
        );
      } else {
        const name =
          platform === 'ios'
            ? `${pad(index, 8)}-PHOTO-2026-03-${pad(7 + (index % 20))}-WA${pad(index, 4)}.png`
            : `IMG-20260307-WA${pad(index, 4)}.png`;
        const hue = Math.floor(random() * 360);
        mediaFiles.push({
          name,
          bytes: makePng(240, 160, (x, y) => {
            const t = (x / 240 + y / 160) / 2;
            const shade = Math.round(60 + t * 150);
            return [
              Math.round(shade * (0.5 + 0.5 * Math.sin((hue * Math.PI) / 180))),
              Math.round(shade * (0.5 + 0.5 * Math.sin(((hue + 120) * Math.PI) / 180))),
              Math.round(shade * (0.5 + 0.5 * Math.sin(((hue + 240) * Math.PI) / 180))),
            ];
          }),
        });
        push(
          cursor,
          platform === 'ios' ? `\u200e<attached: ${name}>` : `${name} (file attached)`,
          sender,
        );
      }
      continue;
    }

    if (!withMedia && roll < 0.18) {
      push(cursor, platform === 'ios' ? '\u200eimage omitted' : '<Media omitted>', sender);
      continue;
    }

    if (roll > 0.95) {
      push(cursor, 'This message was deleted', sender);
      continue;
    }

    const body = at(SMALL_TALK, Math.floor(random() * SMALL_TALK.length));
    const edited = random() > 0.9 ? ' <This message was edited>' : '';
    push(cursor, `${body}${edited}`, sender);
  }

  // Two messages that are indistinguishable from each other, on purpose.
  cursor += 90_000;
  push(cursor, 'ok', at(members, 1));
  push(cursor, 'ok', at(members, 1));

  // A document attachment.
  if (withMedia) {
    cursor += 300_000;
    const docName = platform === 'ios' ? 'Lake cabin details.txt' : 'DOC-20260307-WA0001.txt';
    mediaFiles.push({
      name: docName,
      bytes: new TextEncoder().encode(
        'Cabin check-in 16:00\nKey box code: see message above\nBring: towels, coffee, the good speaker\n',
      ),
    });
    push(
      cursor,
      platform === 'ios' ? `\u200e<attached: ${docName}>` : `${docName} (file attached)`,
      at(members, 0),
    );
  }

  const transcript = `${lines.join('\n')}\n`;
  const expected = {
    title,
    participants: members,
    messageCount: lines.length,
    isGroup: group,
  };

  if (!withMedia) {
    const fileName = `WhatsApp Chat with ${title}.txt`;
    return {
      fileName,
      bytes: new TextEncoder().encode(transcript),
      kind: 'txt',
      transcript,
      mediaFileNames: [],
      expected,
    };
  }

  const zipEntries: Record<string, Uint8Array> = {
    '_chat.txt': new TextEncoder().encode(transcript),
  };
  for (const file of mediaFiles) zipEntries[file.name] = file.bytes;

  return {
    fileName: `WhatsApp Chat - ${title}.zip`,
    bytes: zipSync(zipEntries, { level: 6 }),
    kind: 'zip',
    transcript,
    mediaFileNames: mediaFiles.map((file) => file.name),
    expected,
  };
}

/** A hostile archive, for the import-safety tests. */
export function buildMaliciousArchive(variant: 'traversal' | 'bomb' | 'many_entries'): Uint8Array {
  if (variant === 'traversal') {
    return zipSync({
      '../../etc/passwd': new TextEncoder().encode('root:x:0:0'),
      '_chat.txt': new TextEncoder().encode('17/11/2026, 09:41 - Dana: hello\n'),
    });
  }
  if (variant === 'bomb') {
    // Highly compressible: ~40 MB of zeros in a few kilobytes.
    return zipSync({ 'payload.bin': new Uint8Array(40 * 1024 * 1024) }, { level: 9 });
  }
  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < 400; i += 1) {
    entries[`file-${pad(i, 4)}.bin`] = new Uint8Array([i & 0xff]);
  }
  return zipSync(entries);
}
