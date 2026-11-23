import { describe, expect, it } from 'vitest';
import { concat, toHex } from './bytes';
import {
  AuthenticationError,
  nonceForFrame,
  randomBytes,
  sha256Hex,
} from './primitives';
import {
  ObjectReader,
  ObjectWriter,
  decryptObject,
  decryptObjectStream,
  encryptObject,
  readObjectHeader,
} from './objectFormat';

const material = randomBytes(32);
const objectId = 'obj_0123456789abcdefghjkmn';

async function writePieces(data: Uint8Array, frameSize = 1024) {
  const writer = await ObjectWriter.create({ material, objectId, kind: 'media', frameSize });
  const pieces: Uint8Array[] = [];
  for (const piece of await writer.push(data)) pieces.push(piece);
  const { pieces: tail, stats } = await writer.finish();
  for (const piece of tail) pieces.push(piece);
  return { pieces, stats };
}

describe('round trips', () => {
  it.each([0, 1, 1023, 1024, 1025, 4096, 5000])(
    'encrypts and decrypts %i bytes exactly',
    async (length) => {
      const data = randomBytes(length);
      const { bytes, stats } = await encryptObject({
        material,
        objectId,
        kind: 'media',
        data,
        frameSize: 1024,
      });
      expect(stats.plaintextBytes).toBe(length);
      expect(stats.ciphertextSha256).toBe(await sha256Hex(bytes));
      expect(stats.plaintextSha256).toBe(await sha256Hex(data));
      const out = await decryptObject({ material, bytes, expectedObjectId: objectId });
      expect(toHex(out)).toBe(toHex(data));
    },
  );

  it('always writes at least one frame, so an empty object still carries a final marker', async () => {
    const { stats } = await writePieces(new Uint8Array(0));
    expect(stats.frames).toBe(1);
  });

  it('splits into the expected number of frames', async () => {
    const { stats } = await writePieces(randomBytes(3000), 1024);
    expect(stats.frames).toBe(3);
  });

  it('produces different ciphertext for identical plaintext', async () => {
    const data = randomBytes(64);
    const a = await encryptObject({ material, objectId, kind: 'page', data });
    const b = await encryptObject({ material, objectId, kind: 'page', data });
    expect(a.stats.ciphertextSha256).not.toBe(b.stats.ciphertextSha256);
    expect(a.stats.plaintextSha256).toBe(b.stats.plaintextSha256);
  });

  it('exposes a readable, non-secret header', async () => {
    const { bytes } = await encryptObject({
      material,
      objectId,
      kind: 'manifest',
      data: randomBytes(10),
    });
    const header = readObjectHeader(bytes);
    expect(header).toMatchObject({ v: 1, cipher: 'A256GCM', objectId, kind: 'manifest' });
  });

  it('decrypts a stream delivered in awkwardly sized chunks', async () => {
    const data = randomBytes(7777);
    const { bytes } = await encryptObject({
      material,
      objectId,
      kind: 'media',
      data,
      frameSize: 1024,
    });
    async function* source() {
      for (let i = 0; i < bytes.length; i += 97) yield bytes.subarray(i, i + 97);
    }
    const pieces: Uint8Array[] = [];
    for await (const piece of decryptObjectStream({ material, source: source(), expectedObjectId: objectId })) {
      pieces.push(piece);
    }
    expect(toHex(concat(pieces))).toBe(toHex(data));
  });

  it('accepts one byte at a time', async () => {
    const data = randomBytes(300);
    const { bytes } = await encryptObject({ material, objectId, kind: 'media', data, frameSize: 1024 });
    const reader = new ObjectReader({ material, expectedObjectId: objectId });
    const pieces: Uint8Array[] = [];
    for (const byte of bytes) {
      for (const piece of await reader.push(new Uint8Array([byte]))) pieces.push(piece);
    }
    reader.finish();
    expect(toHex(concat(pieces))).toBe(toHex(data));
  });
});

describe('frame nonces', () => {
  it('are distinct and monotonic', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2048; i += 1) seen.add(toHex(nonceForFrame(i)));
    expect(seen.size).toBe(2048);
    expect(toHex(nonceForFrame(0))).toBe('000000000000000000000000');
    expect(toHex(nonceForFrame(1))).toBe('000000000000000000000001');
  });

  it('refuses a negative or fractional index', () => {
    expect(() => nonceForFrame(-1)).toThrow();
    expect(() => nonceForFrame(1.5)).toThrow();
  });
});

describe('tamper detection', () => {
  const data = randomBytes(3000);

  async function build() {
    return encryptObject({ material, objectId, kind: 'media', data, frameSize: 1024 });
  }

  it('rejects a flipped bit anywhere in the container', async () => {
    const { bytes } = await build();
    for (const offset of [9, 20, bytes.length - 1, Math.floor(bytes.length / 2)]) {
      const altered = Uint8Array.from(bytes);
      altered[offset] = ((altered[offset] as number) ^ 0x01) & 0xff;
      await expect(decryptObject({ material, bytes: altered })).rejects.toThrow();
    }
  });

  it('rejects a wrong key', async () => {
    const { bytes } = await build();
    await expect(decryptObject({ material: randomBytes(32), bytes })).rejects.toThrow(
      AuthenticationError,
    );
  });

  it('rejects an object served in place of the one requested', async () => {
    const other = await encryptObject({
      material,
      objectId: 'obj_zzzzzzzzzzzzzzzzzzzzzz',
      kind: 'media',
      data,
    });
    await expect(
      decryptObject({ material, bytes: other.bytes, expectedObjectId: objectId }),
    ).rejects.toThrow(AuthenticationError);
  });

  it('rejects a truncated container', async () => {
    const { bytes } = await build();
    await expect(
      decryptObject({ material, bytes: bytes.subarray(0, bytes.length - 100) }),
    ).rejects.toThrow(/truncated/i);
  });

  it('rejects a container whose final frame was removed entirely', async () => {
    const { pieces } = await writePieces(data, 1024);
    // pieces: [header, (len, flags, ciphertext) * frames]
    const withoutFinalFrame = concat(pieces.slice(0, pieces.length - 3));
    await expect(decryptObject({ material, bytes: withoutFinalFrame })).rejects.toThrow(
      /truncated/i,
    );
  });

  it('rejects reordered frames', async () => {
    const { pieces } = await writePieces(data, 1024);
    const header = pieces[0] as Uint8Array;
    const frames: Uint8Array[][] = [];
    for (let i = 1; i < pieces.length; i += 3) {
      frames.push([pieces[i] as Uint8Array, pieces[i + 1] as Uint8Array, pieces[i + 2] as Uint8Array]);
    }
    expect(frames.length).toBeGreaterThanOrEqual(3);
    const swapped = [frames[1] as Uint8Array[], frames[0] as Uint8Array[], ...frames.slice(2)];
    await expect(
      decryptObject({ material, bytes: concat([header, ...swapped.flat()]) }),
    ).rejects.toThrow(AuthenticationError);
  });

  it('rejects a duplicated frame', async () => {
    const { pieces } = await writePieces(data, 1024);
    const header = pieces[0] as Uint8Array;
    const firstFrame = pieces.slice(1, 4);
    await expect(
      decryptObject({ material, bytes: concat([header, ...firstFrame, ...firstFrame, ...pieces.slice(4)]) }),
    ).rejects.toThrow(AuthenticationError);
  });

  it('rejects bytes appended after the final frame', async () => {
    const { bytes } = await build();
    const extended = concat([bytes, randomBytes(64)]);
    await expect(decryptObject({ material, bytes: extended })).rejects.toThrow();
  });

  it('rejects data that is not a ChatVault object', async () => {
    await expect(decryptObject({ material, bytes: randomBytes(200) })).rejects.toThrow(
      /not a chatvault object/i,
    );
  });

  it('rejects a frame that claims to be larger than the header allows', async () => {
    const { pieces } = await writePieces(randomBytes(100), 1024);
    const header = pieces[0] as Uint8Array;
    const bogusLength = new Uint8Array([0x00, 0x7f, 0xff, 0xff]);
    await expect(
      decryptObject({ material, bytes: concat([header, bogusLength, new Uint8Array([1]), randomBytes(64)]) }),
    ).rejects.toThrow(/out of range|larger than/i);
  });
});
