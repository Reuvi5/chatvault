import { describe, expect, it } from 'vitest';
import { AuthenticationError, randomBytes } from '@chatvault/crypto';
import { parseTranscript, buildSyntheticExport } from '@chatvault/parser';
import {
  MessageCache,
  createMemoryStorage,
  deserializeMessages,
  serializeMessages,
} from './messageCache';

const material = randomBytes(32);

function sampleMessages(count = 120) {
  const fixture = buildSyntheticExport({
    platform: 'ios',
    withMedia: false,
    messageCount: count,
    seed: 61,
  });
  return parseTranscript(fixture.transcript).messages;
}

describe('cache entries', () => {
  it('round-trip exactly', async () => {
    const messages = sampleMessages();
    const bytes = await serializeMessages({
      material,
      conversationId: 'cnv_aaaaaaaaaaaaaaaaaaaaaa',
      manifestVersion: 3,
      messages,
    });
    const restored = await deserializeMessages({
      material,
      conversationId: 'cnv_aaaaaaaaaaaaaaaaaaaaaa',
      manifestVersion: 3,
      bytes,
    });
    expect(restored).toEqual(messages);
  });

  it('are encrypted: the plaintext is not in the stored bytes', async () => {
    const messages = sampleMessages(40);
    const bytes = await serializeMessages({
      material,
      conversationId: 'cnv_aaaaaaaaaaaaaaaaaaaaaa',
      manifestVersion: 1,
      messages,
    });
    const asText = Buffer.from(bytes).toString('latin1');
    expect(asText).not.toContain('Dana Okonkwo');
    expect(asText).not.toContain('Thursday');
    for (const message of messages.slice(0, 10)) {
      if (message.body.length > 8) expect(asText).not.toContain(message.body);
    }
  });

  it('cannot be read with a different key', async () => {
    const bytes = await serializeMessages({
      material,
      conversationId: 'cnv_aaaaaaaaaaaaaaaaaaaaaa',
      manifestVersion: 1,
      messages: sampleMessages(10),
    });
    await expect(
      deserializeMessages({
        material: randomBytes(32),
        conversationId: 'cnv_aaaaaaaaaaaaaaaaaaaaaa',
        manifestVersion: 1,
        bytes,
      }),
    ).rejects.toThrow(AuthenticationError);
  });

  it('cannot be read as another conversation or another version', async () => {
    const bytes = await serializeMessages({
      material,
      conversationId: 'cnv_aaaaaaaaaaaaaaaaaaaaaa',
      manifestVersion: 2,
      messages: sampleMessages(10),
    });
    await expect(
      deserializeMessages({
        material,
        conversationId: 'cnv_bbbbbbbbbbbbbbbbbbbbbb',
        manifestVersion: 2,
        bytes,
      }),
    ).rejects.toThrow();
    await expect(
      deserializeMessages({
        material,
        conversationId: 'cnv_aaaaaaaaaaaaaaaaaaaaaa',
        manifestVersion: 3,
        bytes,
      }),
    ).rejects.toThrow();
  });
});

describe('MessageCache', () => {
  it('misses, then hits', async () => {
    const cache = new MessageCache(createMemoryStorage(), material);
    const messages = sampleMessages(50);

    expect(await cache.read('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1)).toBeNull();
    await cache.write('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1, messages);
    expect(await cache.read('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1)).toEqual(messages);

    expect(cache.counters).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  it('treats a newer manifest version as a miss and drops the stale entry', async () => {
    const cache = new MessageCache(createMemoryStorage(), material);
    await cache.write('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1, sampleMessages(20));

    expect(await cache.read('cnv_aaaaaaaaaaaaaaaaaaaaaa', 2)).toBeNull();
    expect(cache.counters.evictions).toBe(1);
    // The stale entry is gone, so the old version is not served either.
    expect(await cache.read('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1)).toBeNull();
  });

  it('ignores entries written by another vault sharing the same browser', async () => {
    const storage = createMemoryStorage();
    const theirs = new MessageCache(storage, randomBytes(32));
    await theirs.write('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1, sampleMessages(20));

    const mine = new MessageCache(storage, material);
    expect(await mine.read('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1)).toBeNull();
    expect(mine.counters.evictions).toBe(1);
  });

  it('clears everything, which is what locking the vault does', async () => {
    const cache = new MessageCache(createMemoryStorage(), material);
    await cache.write('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1, sampleMessages(10));
    await cache.clear();
    expect(await cache.read('cnv_aaaaaaaaaaaaaaaaaaaaaa', 1)).toBeNull();
  });

  it('handles a large conversation in one read', async () => {
    const cache = new MessageCache(createMemoryStorage(), material);
    const messages = sampleMessages(4000);
    await cache.write('cnv_big000000000000000000', 1, messages);

    const started = Date.now();
    const restored = await cache.read('cnv_big000000000000000000', 1);
    const elapsed = Date.now() - started;

    expect(restored).toHaveLength(messages.length);
    expect(elapsed).toBeLessThan(2000);
  });
});
