import { describe, expect, it } from 'vitest';
import { toHex } from './bytes';
import { randomBytes } from './primitives';
import {
  RecoveryKeyError,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
} from './recoveryKey';

describe('recovery keys', () => {
  it('round-trips 1000 random keys', () => {
    for (let i = 0; i < 1000; i += 1) {
      const key = randomBytes(32);
      expect(toHex(parseRecoveryKey(formatRecoveryKey(key)))).toBe(toHex(key));
    }
  });

  it('is displayed in readable groups with a version prefix', () => {
    const { display } = generateRecoveryKey();
    expect(display.startsWith('CV1-')).toBe(true);
    const groups = display.slice(4).split('-');
    expect(groups).toHaveLength(11);
    for (const group of groups) expect(group).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('accepts lower case, stray spaces and a missing prefix', () => {
    const key = randomBytes(32);
    const display = formatRecoveryKey(key);
    const mangled = display.slice(4).toLowerCase().replace(/-/g, ' ');
    expect(toHex(parseRecoveryKey(mangled))).toBe(toHex(key));
    expect(toHex(parseRecoveryKey(`  ${display}  `))).toBe(toHex(key));
  });

  it('folds look-alike characters people mistype', () => {
    const key = randomBytes(32);
    const display = formatRecoveryKey(key);
    const confused = display.replace(/0/g, 'O').replace(/1/g, 'l');
    expect(toHex(parseRecoveryKey(confused))).toBe(toHex(key));
  });

  it('catches a single wrong character instead of reporting a wrong key', () => {
    const display = formatRecoveryKey(randomBytes(32));
    const chars = [...display];
    const index = chars.findIndex((c, i) => i > 4 && /[2-9A-HJKMNP-TV-Z]/.test(c));
    chars[index] = chars[index] === 'Z' ? 'Y' : 'Z';
    expect(() => parseRecoveryKey(chars.join(''))).toThrow(RecoveryKeyError);
    expect(() => parseRecoveryKey(chars.join(''))).toThrow(/checksum/i);
  });

  it('reports a length problem clearly', () => {
    expect(() => parseRecoveryKey('CV1-ABCDE-FGHJK')).toThrow(/characters/i);
    expect(() => parseRecoveryKey('')).toThrow(/enter your recovery key/i);
  });

  it('rejects characters outside the alphabet', () => {
    const display = formatRecoveryKey(randomBytes(32));
    expect(() => parseRecoveryKey(`${display.slice(0, -1)}?`)).toThrow(RecoveryKeyError);
  });
});
