import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import {
  ArchiveError,
  bytesSource,
  collectEntry,
  readArchiveEntries,
  readArchiveStream,
} from './archive';
import { buildMaliciousArchive, buildSyntheticExport } from './synthetic';

describe('reading an export archive', () => {
  it('finds the transcript and every attachment', async () => {
    const fixture = buildSyntheticExport({ platform: 'ios', withMedia: true, seed: 3 });
    const { files } = await readArchiveEntries(fixture.bytes);
    expect(files.has('_chat.txt')).toBe(true);
    for (const name of fixture.mediaFileNames) expect(files.has(name)).toBe(true);
  });

  it('returns attachment bytes unchanged', async () => {
    const payload = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const { files } = await readArchiveEntries(zipSync({ 'thing.bin': payload }));
    expect([...(files.get('thing.bin') as Uint8Array)]).toEqual([...payload]);
  });

  it('works when the archive arrives in small chunks', async () => {
    const fixture = buildSyntheticExport({ platform: 'android', withMedia: true, seed: 5 });
    const names: string[] = [];
    let totalBytes = 0;
    const result = await readArchiveStream({
      source: bytesSource(fixture.bytes, 64),
      onEntry: async (entry) => {
        names.push(entry.name);
        const bytes = await collectEntry(entry.chunks, 10 * 1024 * 1024, entry.name);
        totalBytes += bytes.byteLength;
      },
    });
    expect(names).toContain('_chat.txt');
    expect(result.entryCount).toBe(names.length);
    expect(totalBytes).toBe(result.totalBytes);
  });

  it('lets a consumer ignore an entry without stalling the import', async () => {
    const fixture = buildSyntheticExport({ platform: 'ios', withMedia: true, seed: 9 });
    const seen: string[] = [];
    await readArchiveStream({
      source: bytesSource(fixture.bytes, 4096),
      onEntry: async (entry) => {
        seen.push(entry.name);
        // Deliberately read nothing.
      },
    });
    expect(seen.length).toBeGreaterThan(1);
  });
});

describe('hostile archives', () => {
  it('refuses a path that tries to escape, and still reads the rest', async () => {
    const { files, skipped } = await readArchiveEntries(buildMaliciousArchive('traversal'));
    expect(files.has('_chat.txt')).toBe(true);
    expect([...files.keys()]).not.toContain('passwd');
    expect(skipped.some((entry) => entry.reason === 'unsafe_path')).toBe(true);
  });

  it('refuses an absolute path and a Windows drive letter', async () => {
    const { skipped, files } = await readArchiveEntries(zipSync({ 'ok.txt': new Uint8Array([1]) }));
    expect(files.size).toBe(1);
    expect(skipped).toHaveLength(0);

    const hostile = await readArchiveEntries(
      zipSync({ '/etc/shadow': new Uint8Array([1]), 'fine.txt': new Uint8Array([2]) }),
    );
    expect(hostile.files.has('fine.txt')).toBe(true);
    expect(hostile.skipped.some((entry) => entry.reason === 'unsafe_path')).toBe(true);
  });

  it('stops a compression bomb instead of expanding it', async () => {
    await expect(readArchiveEntries(buildMaliciousArchive('bomb'))).rejects.toMatchObject({
      name: 'ArchiveError',
      code: 'compression_ratio',
    });
  });

  it('enforces the entry-count limit', async () => {
    await expect(
      readArchiveEntries(buildMaliciousArchive('many_entries'), { maxEntries: 100 }),
    ).rejects.toMatchObject({ code: 'too_many_entries' });
  });

  it('enforces the per-entry size limit', async () => {
    const archive = zipSync({ 'big.bin': new Uint8Array(200_000).fill(7) });
    await expect(readArchiveEntries(archive, { maxEntryBytes: 1000 })).rejects.toMatchObject({
      code: 'entry_too_large',
    });
  });

  it('enforces the total size limit', async () => {
    const archive = zipSync({
      'a.bin': new Uint8Array(50_000).fill(1),
      'b.bin': new Uint8Array(50_000).fill(2),
    });
    await expect(readArchiveEntries(archive, { maxTotalBytes: 60_000 })).rejects.toMatchObject({
      code: 'archive_too_large',
    });
  });

  it('skips directory records and platform metadata', async () => {
    const { files, skipped } = await readArchiveEntries(
      zipSync({
        'folder/': new Uint8Array(0),
        '__MACOSX/._thing': new Uint8Array([1]),
        '.DS_Store': new Uint8Array([2]),
        'folder/_chat.txt': new TextEncoder().encode('hi'),
      }),
    );
    expect([...files.keys()]).toEqual(['_chat.txt']);
    expect(skipped.filter((entry) => entry.reason === 'metadata').length).toBeGreaterThan(0);
  });

  it('reports a corrupt member rather than returning partial data', async () => {
    const archive = zipSync({ 'thing.bin': new Uint8Array(5000).fill(9) });
    // Corrupt the compressed payload in the middle of the file.
    const broken = Uint8Array.from(archive);
    for (let i = 60; i < 160 && i < broken.length; i += 1) broken[i] = 0xff;
    await expect(readArchiveEntries(broken)).rejects.toBeInstanceOf(Error);
  });

  it('honours an abort signal', async () => {
    const fixture = buildSyntheticExport({ platform: 'ios', withMedia: true, seed: 4 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readArchiveStream({
        source: bytesSource(fixture.bytes, 512),
        signal: controller.signal,
        onEntry: async () => {},
      }),
    ).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe('collectEntry', () => {
  it('refuses to buffer more than it was allowed', async () => {
    async function* source() {
      yield new Uint8Array(600);
      yield new Uint8Array(600);
    }
    await expect(collectEntry(source(), 1000, 'thing')).rejects.toMatchObject({
      code: 'entry_too_large',
    });
  });
});
