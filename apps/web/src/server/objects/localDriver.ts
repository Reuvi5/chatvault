/**
 * Local filesystem object driver.
 *
 * Used for development, for the test suite and for the restore drill, where it
 * stands in for a bucket. Parts are written individually and concatenated on
 * completion, so an interrupted upload leaves no half-written object behind.
 */
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { ObjectStoreError, assertSafeKey, type ObjectDriver, type ObjectHead } from './driver';

export class LocalObjectDriver implements ObjectDriver {
  readonly kind = 'local' as const;

  constructor(
    readonly label: string,
    private readonly root: string,
    readonly partSizeBytes: number,
  ) {}

  get location(): string {
    return this.root;
  }

  private objectPath(key: string): string {
    assertSafeKey(key);
    return join(this.root, 'objects', key);
  }

  private partsDirectory(key: string): string {
    assertSafeKey(key);
    return join(this.root, 'parts', key);
  }

  async beginUpload(key: string): Promise<{ uploadId: string | null }> {
    const directory = this.partsDirectory(key);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    return { uploadId: null };
  }

  async uploadPart(
    key: string,
    _uploadId: string | null,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<{ etag: string | null }> {
    const directory = this.partsDirectory(key);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${String(partNumber).padStart(6, '0')}.part`), bytes);
    return { etag: null };
  }

  async completeUpload(key: string): Promise<ObjectHead> {
    const directory = this.partsDirectory(key);
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith('.part')).sort();
    } catch {
      throw new ObjectStoreError(`No upload in progress for ${key}`, 'not_found');
    }
    const target = this.objectPath(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.assembling`;
    await writeFile(temporary, new Uint8Array(0));
    let total = 0;
    for (const name of names) {
      const bytes = await readFile(join(directory, name));
      await appendFile(temporary, bytes);
      total += bytes.byteLength;
    }
    await rename(temporary, target);
    await rm(directory, { recursive: true, force: true });
    return { bytes: total };
  }

  async abortUpload(key: string): Promise<void> {
    await rm(this.partsDirectory(key), { recursive: true, force: true });
  }

  async put(key: string, bytes: Uint8Array): Promise<ObjectHead> {
    const target = this.objectPath(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.writing`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
    return { bytes: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.objectPath(key)));
    } catch (error) {
      throw new ObjectStoreError(`${key} is not in ${this.label}`, 'not_found', error);
    }
  }

  async getWebStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const path = this.objectPath(key);
    try {
      await stat(path);
    } catch (error) {
      throw new ObjectStoreError(`${key} is not in ${this.label}`, 'not_found', error);
    }
    return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const info = await stat(this.objectPath(key));
      return { bytes: info.size };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.objectPath(key), { force: true });
    await rm(this.partsDirectory(key), { recursive: true, force: true });
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(join(this.root, 'objects'), { recursive: true });
      return { ok: true, detail: `local directory ${this.root}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
