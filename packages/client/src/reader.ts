/**
 * Reading an archive back.
 *
 * Decryption happens here, on the device. The server hands over ciphertext and
 * a digest of that ciphertext; the digest is only a check against a corrupted
 * transfer, because the authority on integrity is the AES-GCM tag on every
 * frame, which the server cannot produce.
 *
 * Pages and attachments also carry a plaintext digest inside the (encrypted)
 * manifest. Verifying it catches a server that serves an older, still perfectly
 * authentic object in place of the current one.
 */
import {
  type ConversationManifest,
  type ConversationSummary,
  type ManifestAttachmentRef,
  type ManifestPageRef,
} from '@chatvault/protocol';
import {
  AuthenticationError,
  decryptJsonObject,
  decryptObject,
  deriveSubkey,
  sha256Hex,
  type UnlockedVault,
} from '@chatvault/crypto';
import type { CanonicalMessage } from '@chatvault/parser';
import type { ApiClient } from './api';
import { createNullCache, type CiphertextCache } from './cache';

export interface ConversationEntry {
  summary: ConversationSummary;
  manifest: ConversationManifest | null;
  /** Set when the manifest could not be read, so the UI can say which one. */
  error: string | null;
}

export interface IntegrityReport {
  conversationId: string;
  pagesChecked: number;
  attachmentsChecked: number;
  messageCount: number;
  problems: Array<{ objectId: string; kind: 'page' | 'media'; detail: string }>;
  ok: boolean;
}

export class ArchiveReader {
  private constructor(
    private readonly api: ApiClient,
    private readonly objectsMaterial: Uint8Array,
    private readonly manifestMaterial: Uint8Array,
    private readonly cache: CiphertextCache,
  ) {}

  static async create(options: {
    api: ApiClient;
    vault: UnlockedVault;
    cache?: CiphertextCache;
  }): Promise<ArchiveReader> {
    return new ArchiveReader(
      options.api,
      await deriveSubkey(options.vault.key, 'objects'),
      await deriveSubkey(options.vault.key, 'manifests'),
      options.cache ?? createNullCache(),
    );
  }

  private async fetchObject(objectId: string): Promise<Uint8Array> {
    const cached = await this.cache.get(objectId);
    if (cached) return cached;
    const { bytes, expectedSha256 } = await this.api.downloadObject(objectId);
    const actual = await sha256Hex(bytes);
    if (expectedSha256 && actual !== expectedSha256) {
      throw new Error(
        `The download of ${objectId} did not match its recorded checksum, so it was not used.`,
      );
    }
    await this.cache.put(objectId, bytes);
    return bytes;
  }

  async listConversations(): Promise<ConversationEntry[]> {
    const { conversations } = await this.api.conversations();
    const entries: ConversationEntry[] = [];
    for (const summary of conversations) {
      if (!summary.manifestObjectId) {
        entries.push({ summary, manifest: null, error: 'This import never finished.' });
        continue;
      }
      try {
        entries.push({
          summary,
          manifest: await this.loadManifest(summary.manifestObjectId),
          error: null,
        });
      } catch (error) {
        entries.push({
          summary,
          manifest: null,
          error:
            error instanceof AuthenticationError
              ? 'This conversation could not be decrypted with the current key.'
              : error instanceof Error
                ? error.message
                : 'Unknown error',
        });
      }
    }
    return entries;
  }

  async loadManifest(manifestObjectId: string): Promise<ConversationManifest> {
    const bytes = await this.fetchObject(manifestObjectId);
    return decryptJsonObject<ConversationManifest>({
      material: this.manifestMaterial,
      bytes,
      expectedObjectId: manifestObjectId,
    });
  }

  async loadPage(page: ManifestPageRef): Promise<CanonicalMessage[]> {
    const bytes = await this.fetchObject(page.objectId);
    const plaintext = await decryptObject({
      material: this.objectsMaterial,
      bytes,
      expectedObjectId: page.objectId,
    });
    const digest = await sha256Hex(plaintext);
    if (digest !== page.plaintextSha256) {
      throw new Error(
        `Page ${page.pageId} decrypted correctly but does not match the index. The archive may have been rolled back to an older version.`,
      );
    }
    return JSON.parse(new TextDecoder('utf-8').decode(plaintext)) as CanonicalMessage[];
  }

  /** Load the whole conversation, page by page, reporting progress. */
  async loadMessages(
    manifest: ConversationManifest,
    options: {
      onProgress?: (pagesDone: number, pagesTotal: number) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<CanonicalMessage[]> {
    const out: CanonicalMessage[] = [];
    for (const [index, page] of manifest.pages.entries()) {
      if (options.signal?.aborted) throw new Error('Cancelled');
      out.push(...(await this.loadPage(page)));
      options.onProgress?.(index + 1, manifest.pages.length);
    }
    return out.map((message, index) =>
      message.seq === index ? message : { ...message, seq: index },
    );
  }

  async loadAttachment(
    attachment: ManifestAttachmentRef,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (!attachment.objectId || attachment.missing) {
      throw new Error(
        `${attachment.fileName} was not included in the export, so it is not archived.`,
      );
    }
    const bytes = await this.fetchObject(attachment.objectId);
    const plaintext = await decryptObject({
      material: this.objectsMaterial,
      bytes,
      expectedObjectId: attachment.objectId,
    });
    if (attachment.plaintextSha256) {
      const digest = await sha256Hex(plaintext);
      if (digest !== attachment.plaintextSha256) {
        throw new Error(`${attachment.fileName} does not match the checksum recorded at import.`);
      }
    }
    return { bytes: plaintext, mimeType: attachment.mimeType ?? 'application/octet-stream' };
  }

  /**
   * Read every object of a conversation and check it against the manifest.
   * This is what "open your archive and make sure it is really there" means,
   * and it is what the restore drill runs (plan §7, §15.3).
   */
  async verifyIntegrity(
    manifest: ConversationManifest,
    options: { includeMedia?: boolean; onProgress?: (done: number, total: number) => void } = {},
  ): Promise<IntegrityReport> {
    const problems: IntegrityReport['problems'] = [];
    const media = options.includeMedia
      ? manifest.attachments.filter((item) => !item.missing && item.objectId)
      : [];
    const total = manifest.pages.length + media.length;
    let done = 0;
    let messageCount = 0;

    for (const page of manifest.pages) {
      try {
        messageCount += (await this.loadPage(page)).length;
      } catch (error) {
        problems.push({
          objectId: page.objectId,
          kind: 'page',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      done += 1;
      options.onProgress?.(done, total);
    }

    for (const attachment of media) {
      try {
        await this.loadAttachment(attachment);
      } catch (error) {
        problems.push({
          objectId: attachment.objectId as string,
          kind: 'media',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      done += 1;
      options.onProgress?.(done, total);
    }

    return {
      conversationId: manifest.conversationId,
      pagesChecked: manifest.pages.length,
      attachmentsChecked: media.length,
      messageCount,
      problems,
      ok: problems.length === 0 && messageCount === manifest.messageCount,
    };
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
  }
}
