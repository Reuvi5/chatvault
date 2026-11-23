import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  concat,
  equalConstantTime,
  fromBase64,
  fromHex,
  fromUtf8,
  readUint32BE,
  toBase64,
  toHex,
  toUtf8,
  writeUint32BE,
  writeUint64BE,
} from './bytes';
import { randomBytes } from './primitives';

describe('encoding helpers', () => {
  it('round-trips base64 for every length from 0 to 64', () => {
    for (let length = 0; length <= 64; length += 1) {
      const bytes = randomBytes(length);
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    }
  });

  it('matches the platform base64 implementation', () => {
    const bytes = randomBytes(97);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('round-trips hex and rejects malformed input', () => {
    const bytes = randomBytes(33);
    expect([...fromHex(toHex(bytes))]).toEqual([...bytes]);
    expect(() => fromHex('abc')).toThrow(/odd length/i);
    expect(() => fromHex('zz')).toThrow(/non-hex/i);
  });

  it('round-trips utf-8 including emoji and right-to-left text', () => {
    const text = 'שלום · مرحبا · 👋🏽 · ok';
    expect(fromUtf8(toUtf8(text))).toBe(text);
  });

  it('rejects invalid utf-8 rather than substituting replacement characters', () => {
    expect(() => fromUtf8(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow();
  });
});

describe('integer helpers', () => {
  it('writes and reads big-endian 32-bit values', () => {
    expect([...writeUint32BE(0)]).toEqual([0, 0, 0, 0]);
    expect([...writeUint32BE(0xdeadbeef)]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(readUint32BE(writeUint32BE(4_294_967_295))).toBe(4_294_967_295);
    expect(() => writeUint32BE(-1)).toThrow();
    expect(() => writeUint32BE(2 ** 32)).toThrow();
  });

  it('writes big-endian 64-bit counters', () => {
    expect([...writeUint64BE(1)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...writeUint64BE(256)]).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    expect(() => writeUint64BE(-1)).toThrow();
  });
});

describe('constant-time comparison', () => {
  it('compares by value and rejects different lengths', () => {
    expect(equalConstantTime(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(equalConstantTime(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(equalConstantTime(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('canonical JSON for additional authenticated data', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('keeps array order, which is meaningful', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('drops undefined values and refuses non-finite numbers', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe('concat', () => {
  it('joins chunks in order', () => {
    expect([...concat([new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3])])]).toEqual([
      1, 2, 3,
    ]);
  });
});
