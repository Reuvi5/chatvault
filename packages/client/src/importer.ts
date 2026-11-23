/**
 * The import pipeline (plan §3 "Import a chat", §6, §8).
 *
 * Order of operations, and why:
 *
 *   1. Parse and preview **locally**. Nothing is uploaded until the person has
 *      seen what was found, including everything that is missing or uncertain.
 *   2. Merge against what the archive already holds, keeping every message we
 *      already have.
 *   3. Encrypt on the device, streaming, one frame at a time, and upload only
 *      ciphertext in resumable parts.
 *   4. Write the manifest last, so a half-finished import never becomes the
 *      current state of a conversation.
 *
 * The original export is never deleted and never uploaded unless the person
 * explicitly asks for it to be kept.
 */
import {
  DEFAULT_FRAME_SIZE,
  IMPORT_LIMITS,
  MANIFEST_VERSION,
  MESSAGES_PER_PAGE,
  OBJECT_FORMAT_VERSION,
  PARSER_VERSION,
  attachmentKindFor,
  mimeTypeFor,
  type ConversationManifest,
  type ManifestAttachmentRef,
  type ManifestPageRef,
  type ObjectKind,
} from '@chatvault/protocol';
import {
  ObjectWriter,
  createStreamingSha256,
  deriveSubkey,
  sha256Hex,
  toUtf8,
  type UnlockedVault,
} from '@chatvault/crypto';
import {
  bytesSource,
  collectEntry,
  inferTitleAndSelf,
  matchAttachments,
  mergeMessages,
  parseTranscript,
  pickTranscriptEntry,
  readArchiveStream,
  type CanonicalMessage,
  type DateOrder,
  type MergeResult,
  type ParseWarning,
  type ParsedTranscript,
  type SkippedEntry,
} from '@chatvault/parser';
import type { ApiClient } from './api';
import { PartBuffer, collectStream, streamToAsyncIterable, withRetry } from './bytes';

/* ------------------------------------------------------------------ sources */

export interface ImportSource {
  fileName: string;
  byteLength: number;
  /** Must be callable more than once: preview and upload each read the file. */
  open(): AsyncIterable<Uint8Array>;
}

export function bytesImportSource(fileName: string, bytes: Uint8Array): ImportSource {
  return {
    fileName,
    byteLength: bytes.byteLength,
    open: () => bytesSource(bytes),
  };
}

export function fileImportSource(file: File): ImportSource {
  return {
    fileName: file.name,
    byteLength: file.size,
    open: () => streamToAsyncIterable(file.stream()),
  };
}

/* ------------------------------------------------------------------ preview */

export interface PreviewAttachment {
  fileName: string;
  /** Name of the archive member that supplies it, or null when it is missing. */
  entryName: string | null;
  byteLength: number | null;
  missing: boolean;
  kind: ManifestAttachmentRef['kind'];
  mimeType: string | null;
}

export interface ImportPreview {
  source: { fileName: string; byteLength: number; sha256: string; kind: 'zip' | 'txt' };
  parsed: ParsedTranscript;
  title: string;
  selfName: string | null;
  titleConfidence: 'certain' | 'inferred' | 'assumed';
  attachments: PreviewAttachment[];
  /** Files in the archive that no message refers to. They are not uploaded. */
  unreferencedFiles: string[];
  skippedEntries: SkippedEntry[];
  estimates: {
    messagePlaintextBytes: number;
    mediaPlaintextBytes: number;
    estimatedCiphertextBytes: number;
  };
  warnings: ParseWarning[];
}

const ZIP_MAGIC = [0x50, 0x4b];

function looksLikeZip(fileName: string, firstChunk: Uint8Array | null): boolean {
  if (firstChunk && firstChunk.byteLength >= 2) {
    return firstChunk[0] === ZIP_MAGIC[0] && firstChunk[1] === ZIP_MAGIC[1];
  }
  return /\.zip$/iu.test(fileName);
}

/** Estimate the container size so quotas can be checked before any upload. */
export function estimateCiphertextBytes(plaintextBytes: number, frameSize = DEFAULT_FRAME_SIZE): number {
  const frames = Math.max(1, Math.floor(plaintextBytes / frameSize) + 1);
  return plaintextBytes + frames * 21 + 260;
}

export interface PreviewOptions {
  source: ImportSource;
  dateOrder?: DateOrder;
  signal?: AbortSignal;
  onProgress?: (bytesRead: number) => void;
}

export async function previewImport(options: PreviewOptions): Promise<ImportPreview> {
  const { source } = options;
  const hasher = await createStreamingSha256();
  let firstChunk: Uint8Array | null = null;
  let bytesRead = 0;

  async function* hashed(): AsyncGenerator<Uint8Array> {
    for await (const chunk of source.open()) {
      if (options.signal?.aborted) throw new Error('Cancelled');
      hasher.update(chunk);
      bytesRead += chunk.byteLength;
      firstChunk ??= chunk;
      options.onProgress?.(bytesRead);
      yield chunk;
    }
  }

  const textFiles = new Map<string, Uint8Array>();
  const mediaSizes = new Map<string, number>();
  let skipped: SkippedEntry[] = [];
  let kind: 'zip' | 'txt';
  let transcriptText: string;

  const iterator = hashed();
  const probe = await iterator.next();
  const head = probe.done ? null : (probe.value as Uint8Array);
  kind = looksLikeZip(source.fileName, head) ? 'zip' : 'txt';

  async function* replay(): AsyncGenerator<Uint8Array> {
    if (head) yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value as Uint8Array;
    }
  }

  if (kind === 'txt') {
    const bytes = await collectStream(replay());
    if (bytes.byteLength > IMPORT_LIMITS.maxTranscriptBytes) {
      throw new Error('That transcript is larger than ChatVault will import.');
    }
    transcriptText = new TextDecoder('utf-8').decode(bytes);
  } else {
    const result = await readArchiveStream({
      source: replay(),
      signal: options.signal,
      onEntry: async (entry) => {
        if (/\.txt$/iu.test(entry.name) && textFiles.size < 8) {
          textFiles.set(
            entry.name,
            await collectEntry(entry.chunks, IMPORT_LIMITS.maxTranscriptBytes, entry.name),
          );
          return;
        }
        let size = 0;
        for await (const chunk of entry.chunks) size += chunk.byteLength;
        mediaSizes.set(entry.name, size);
      },
    });
    skipped = result.skipped;

    const choice = pickTranscriptEntry([...textFiles.keys()]);
    if (!choice.name) {
      throw new Error(
        'That archive does not contain a chat transcript (a .txt file), so there is nothing to import.',
      );
    }
    // A .txt that is not the transcript is an ordinary document attachment.
    for (const [name, bytes] of textFiles) {
      if (name !== choice.name) mediaSizes.set(name, bytes.byteLength);
    }
    transcriptText = new TextDecoder('utf-8').decode(textFiles.get(choice.name) as Uint8Array);
  }

  const sourceSha256 = hasher.hex();
  const parsed = parseTranscript(transcriptText, options.dateOrder ? { dateOrder: options.dateOrder } : {});
  const match = matchAttachments(parsed.referencedFiles, [...mediaSizes.keys()]);
  const guess = inferTitleAndSelf({
    sourceFileName: source.fileName,
    participants: parsed.participants,
    isGroup: parsed.isGroup,
  });

  const attachments: PreviewAttachment[] = parsed.referencedFiles.map((fileName) => {
    const entryName = match.matched.get(fileName) ?? null;
    return {
      fileName,
      entryName,
      byteLength: entryName ? (mediaSizes.get(entryName) ?? 0) : null,
      missing: entryName === null,
      kind: attachmentKindFor(fileName),
      mimeType: mimeTypeFor(fileName),
    };
  });

  const warnings = [...parsed.warnings];
  if (match.missing.length > 0) {
    warnings.push({
      code: 'attachments_missing',
      message:
        'Some attachments referenced in the transcript are not in this export. ChatVault will record them as missing rather than pretend they are archived.',
      count: match.missing.length,
      samples: match.missing.slice(0, 5),
    });
  }
  if (match.unreferenced.length > 0) {
    warnings.push({
      code: 'attachments_unreferenced',
      message:
        'The archive contains files that no message refers to. They are not uploaded, so you are not billed for them.',
      count: match.unreferenced.length,
      samples: match.unreferenced.slice(0, 5),
    });
  }
  if (guess.selfName === null && parsed.participants.length > 0) {
    warnings.push({
      code: 'self_name_unknown',
      message:
        'ChatVault could not tell which participant is you, so choose one to show your own messages on the right.',
    });
  }

  const messagePlaintextBytes = toUtf8(JSON.stringify(parsed.messages)).byteLength;
  const mediaPlaintextBytes = attachments.reduce((sum, item) => sum + (item.byteLength ?? 0), 0);

  return {
    source: { fileName: source.fileName, byteLength: source.byteLength || bytesRead, sha256: sourceSha256, kind },
    parsed,
    title: guess.title,
    selfName: guess.selfName,
    titleConfidence: guess.confidence,
    attachments,
    unreferencedFiles: match.unreferenced,
    skippedEntries: skipped,
    estimates: {
      messagePlaintextBytes,
      mediaPlaintextBytes,
      estimatedCiphertextBytes:
        estimateCiphertextBytes(messagePlaintextBytes) +
        attachments.reduce(
          (sum, item) => sum + (item.byteLength === null ? 0 : estimateCiphertextBytes(item.byteLength)),
          0,
        ) +
        estimateCiphertextBytes(4096),
    },
    warnings,
  };
}

/* ------------------------------------------------------------------- upload */

export interface ImportProgress {
  phase: 'merging' | 'creating' | 'messages' | 'media' | 'manifest' | 'finalising' | 'done';
  label: string;
  objectsDone: number;
  objectsTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

interface UploadedObject {
  objectId: string;
  ciphertextBytes: number;
  plaintextBytes: number;
  plaintextSha256: string;
}

async function uploadEncrypted(options: {
  api: ApiClient;
  material: Uint8Array;
  importId: string;
  kind: ObjectKind;
  data: AsyncIterable<Uint8Array>;
  estimatedCiphertextBytes: number;
  signal?: AbortSignal;
  onBytes?: (delta: number) => void;
}): Promise<UploadedObject> {
  const auth = await options.api.authorizeUpload({
    importId: options.importId,
    kind: options.kind,
    expectedCiphertextBytes: options.estimatedCiphertextBytes,
  });

  const writer = await ObjectWriter.create({
    material: options.material,
    objectId: auth.objectId,
    kind: options.kind,
  });

  const buffer = new PartBuffer();
  const parts: Array<{ part: number; bytes: number }> = [];
  let partNumber = 1;

  const sendPart = async (bytes: Uint8Array) => {
    const number = partNumber;
    partNumber += 1;
    await withRetry(() => options.api.uploadPart(auth.uploadUrlTemplate, number, auth.ticket, bytes), {
      signal: options.signal,
    });
    parts.push({ part: number, bytes: bytes.byteLength });
    options.onBytes?.(bytes.byteLength);
  };

  const drain = async (final: boolean) => {
    while (buffer.size >= auth.partSizeBytes) await sendPart(buffer.take(auth.partSizeBytes));
    if (final && buffer.size > 0) await sendPart(buffer.take(buffer.size));
  };

  for await (const chunk of options.data) {
    if (options.signal?.aborted) throw new Error('Cancelled');
    for (const piece of await writer.push(chunk)) buffer.push(piece);
    await drain(false);
  }
  const { pieces, stats } = await writer.finish();
  for (const piece of pieces) buffer.push(piece);
  await drain(true);

  await options.api.completeObject({
    ticket: auth.ticket,
    ciphertextBytes: stats.ciphertextBytes,
    ciphertextSha256: stats.ciphertextSha256,
    parts,
  });

  return {
    objectId: auth.objectId,
    ciphertextBytes: stats.ciphertextBytes,
    plaintextBytes: stats.plaintextBytes,
    plaintextSha256: stats.plaintextSha256,
  };
}

interface PageDraft {
  pageId: string;
  messages: CanonicalMessage[];
  plaintext: Uint8Array;
  plaintextSha256: string;
}

async function buildPageDrafts(messages: readonly CanonicalMessage[]): Promise<PageDraft[]> {
  const drafts: PageDraft[] = [];
  for (let start = 0; start < Math.max(1, messages.length); start += MESSAGES_PER_PAGE) {
    const slice = messages.slice(start, start + MESSAGES_PER_PAGE);
    const plaintext = toUtf8(JSON.stringify(slice));
    drafts.push({
      pageId: `p${String(drafts.length).padStart(5, '0')}`,
      messages: slice,
      plaintext,
      plaintextSha256: await sha256Hex(plaintext),
    });
    if (messages.length === 0) break;
  }
  return drafts;
}

export interface RunImportOptions {
  api: ApiClient;
  vault: UnlockedVault;
  source: ImportSource;
  preview: ImportPreview;
  assumedTimeZone: string;
  /** Null or omitted starts a new conversation. */
  conversationId?: string | null;
  existingManifest?: ConversationManifest | null;
  existingMessages?: readonly CanonicalMessage[];
  title?: string;
  selfName?: string | null;
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
}

export interface ImportOutcome {
  importId: string;
  conversationId: string;
  manifest: ConversationManifest;
  merge: MergeResult;
  uploadedObjects: number;
  reusedObjects: number;
  ciphertextBytesUploaded: number;
}

export async function runImport(options: RunImportOptions): Promise<ImportOutcome> {
  const { api, preview, vault } = options;
  const objectsMaterial = await deriveSubkey(vault.key, 'objects');
  const manifestMaterial = await deriveSubkey(vault.key, 'manifests');
  const existingMessages = options.existingMessages ?? [];
  const nowMs = Date.now();

  const report = (progress: Partial<ImportProgress> & Pick<ImportProgress, 'phase' | 'label'>) => {
    options.onProgress?.({
      objectsDone: 0,
      objectsTotal: 0,
      bytesDone: 0,
      bytesTotal: preview.estimates.estimatedCiphertextBytes,
      ...progress,
    });
  };

  report({ phase: 'merging', label: 'Comparing this export with your archive' });
  const merge = mergeMessages(existingMessages, preview.parsed.messages);
  const pages = await buildPageDrafts(merge.merged);

  const existingPages = new Map(
    (options.existingManifest?.pages ?? []).map((page) => [page.plaintextSha256, page]),
  );
  const existingAttachments = new Map(
    (options.existingManifest?.attachments ?? []).map((item) => [item.fileName, item]),
  );

  const pagesToUpload = pages.filter((page) => !existingPages.has(page.plaintextSha256));
  const attachmentsToUpload = preview.attachments.filter((item) => {
    if (item.missing || !item.entryName) return false;
    const previous = existingAttachments.get(item.fileName);
    return !previous || previous.missing || !previous.objectId;
  });

  const objectsTotal = pagesToUpload.length + attachmentsToUpload.length + 1;
  let objectsDone = 0;
  let bytesDone = 0;
  const onBytes = (delta: number) => {
    bytesDone += delta;
  };

  report({ phase: 'creating', label: 'Opening an import', objectsTotal });
  const created = await api.createImport({
    conversationId: options.conversationId ?? null,
    plannedCiphertextBytes: preview.estimates.estimatedCiphertextBytes,
    plannedObjectCount: objectsTotal,
    parserVersion: PARSER_VERSION,
    cryptoVersion: OBJECT_FORMAT_VERSION,
  });

  /* Message pages. */
  const pageRefs: ManifestPageRef[] = [];
  let uploadedObjects = 0;
  let reusedObjects = 0;
  let ciphertextBytesUploaded = 0;

  for (const page of pages) {
    const reuse = existingPages.get(page.plaintextSha256);
    if (reuse) {
      reusedObjects += 1;
      pageRefs.push({ ...reuse, pageId: page.pageId });
      continue;
    }
    report({
      phase: 'messages',
      label: `Encrypting messages (${String(pageRefs.length + 1)} of ${String(pages.length)})`,
      objectsDone,
      objectsTotal,
      bytesDone,
    });
    const uploaded = await uploadEncrypted({
      api,
      material: objectsMaterial,
      importId: created.importId,
      kind: 'page',
      data: bytesSource(page.plaintext),
      estimatedCiphertextBytes: estimateCiphertextBytes(page.plaintext.byteLength),
      signal: options.signal,
      onBytes,
    });
    uploadedObjects += 1;
    objectsDone += 1;
    ciphertextBytesUploaded += uploaded.ciphertextBytes;
    pageRefs.push({
      pageId: page.pageId,
      objectId: uploaded.objectId,
      messageCount: page.messages.length,
      firstLocalTs: page.messages[0]?.localTs ?? '',
      lastLocalTs: page.messages.at(-1)?.localTs ?? '',
      plaintextSha256: page.plaintextSha256,
      ciphertextBytes: uploaded.ciphertextBytes,
    });
  }

  /* Attachments, streamed straight out of the archive. */
  const attachmentRefs = new Map<string, ManifestAttachmentRef>();
  for (const item of preview.attachments) {
    const previous = existingAttachments.get(item.fileName);
    if (previous && !previous.missing && previous.objectId) {
      reusedObjects += 1;
      attachmentRefs.set(item.fileName, previous);
      continue;
    }
    attachmentRefs.set(item.fileName, {
      fileName: item.fileName,
      objectId: null,
      byteLength: item.byteLength,
      mimeType: item.mimeType,
      plaintextSha256: null,
      ciphertextBytes: 0,
      missing: item.missing,
      kind: item.kind,
    });
  }

  if (attachmentsToUpload.length > 0) {
    const wanted = new Map(attachmentsToUpload.map((item) => [item.entryName as string, item]));
    let index = 0;
    await readArchiveStream({
      source: options.source.open(),
      signal: options.signal,
      onEntry: async (entry) => {
        const item = wanted.get(entry.name);
        if (!item) return;
        index += 1;
        report({
          phase: 'media',
          label: `Encrypting ${item.fileName} (${String(index)} of ${String(attachmentsToUpload.length)})`,
          objectsDone,
          objectsTotal,
          bytesDone,
        });
        const uploaded = await uploadEncrypted({
          api,
          material: objectsMaterial,
          importId: created.importId,
          kind: 'media',
          data: entry.chunks,
          estimatedCiphertextBytes: estimateCiphertextBytes(item.byteLength ?? 0),
          signal: options.signal,
          onBytes,
        });
        uploadedObjects += 1;
        objectsDone += 1;
        ciphertextBytesUploaded += uploaded.ciphertextBytes;
        attachmentRefs.set(item.fileName, {
          fileName: item.fileName,
          objectId: uploaded.objectId,
          byteLength: uploaded.plaintextBytes,
          mimeType: item.mimeType,
          plaintextSha256: uploaded.plaintextSha256,
          ciphertextBytes: uploaded.ciphertextBytes,
          missing: false,
          kind: item.kind,
        });
      },
    });
  }

  /* The manifest, written last. */
  const previousImports = options.existingManifest?.imports ?? [];
  const manifest: ConversationManifest = {
    v: MANIFEST_VERSION,
    conversationId: created.conversationId,
    manifestVersion: (options.existingManifest?.manifestVersion ?? 0) + 1,
    title: options.title ?? options.existingManifest?.title ?? preview.title,
    isGroup: options.existingManifest?.isGroup || preview.parsed.isGroup,
    participants: mergeUnique(options.existingManifest?.participants ?? [], preview.parsed.participants),
    selfName: options.selfName ?? options.existingManifest?.selfName ?? preview.selfName,
    messageCount: merge.merged.length,
    firstLocalTs: merge.merged[0]?.localTs ?? null,
    lastLocalTs: merge.merged.at(-1)?.localTs ?? null,
    assumedTimeZone: options.assumedTimeZone,
    dateOrder: preview.parsed.dateOrder,
    dateOrderConfidence: preview.parsed.dateOrderConfidence,
    pages: pageRefs,
    attachments: [...attachmentRefs.values()],
    imports: [
      ...previousImports.slice(-49),
      {
        importId: created.importId,
        importedAtMs: nowMs,
        parserVersion: preview.parsed.parserVersion,
        sourceSha256: preview.source.sha256,
        sourceFileName: preview.source.fileName,
        sourceBytes: preview.source.byteLength,
        messagesAdded: merge.added,
        duplicatesSkipped: merge.duplicatesSkipped,
        ambiguities: merge.ambiguities.length,
        warnings: preview.warnings.map((warning) => warning.message),
      },
    ],
    warnings: dedupe([
      ...(options.existingManifest?.warnings ?? []),
      ...preview.warnings.map((warning) => warning.message),
      ...merge.warnings,
    ]).slice(-40),
    createdAtMs: options.existingManifest?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
  };

  report({ phase: 'manifest', label: 'Encrypting the index', objectsDone, objectsTotal, bytesDone });
  const manifestPlaintext = toUtf8(JSON.stringify(manifest));
  const manifestObject = await uploadEncrypted({
    api,
    material: manifestMaterial,
    importId: created.importId,
    kind: 'manifest',
    data: bytesSource(manifestPlaintext),
    estimatedCiphertextBytes: estimateCiphertextBytes(manifestPlaintext.byteLength),
    signal: options.signal,
    onBytes,
  });
  uploadedObjects += 1;
  objectsDone += 1;
  ciphertextBytesUploaded += manifestObject.ciphertextBytes;

  /* Objects the previous manifest referenced and this one no longer does. */
  const keptObjectIds = new Set<string>([
    ...pageRefs.map((page) => page.objectId),
    ...[...attachmentRefs.values()].map((item) => item.objectId).filter((id): id is string => !!id),
    manifestObject.objectId,
  ]);
  const supersededObjectIds = [
    ...(options.existingManifest?.pages ?? []).map((page) => page.objectId),
    ...(options.existingManifest?.attachments ?? [])
      .map((item) => item.objectId)
      .filter((id): id is string => !!id),
  ].filter((id) => !keptObjectIds.has(id));

  report({ phase: 'finalising', label: 'Checking what was stored', objectsDone, objectsTotal, bytesDone });
  await api.completeImport(created.importId, {
    manifestObjectId: manifestObject.objectId,
    manifestVersion: manifest.manifestVersion,
    objectIds: [...keptObjectIds].filter(
      (id) => id === manifestObject.objectId || !existingObjectIds(options).has(id),
    ),
    supersededObjectIds: [...new Set(supersededObjectIds)],
  });

  report({
    phase: 'done',
    label: 'Stored and queued for backup',
    objectsDone,
    objectsTotal,
    bytesDone,
  });

  return {
    importId: created.importId,
    conversationId: created.conversationId,
    manifest,
    merge,
    uploadedObjects,
    reusedObjects,
    ciphertextBytesUploaded,
  };
}

function existingObjectIds(options: RunImportOptions): Set<string> {
  const manifest = options.existingManifest;
  if (!manifest) return new Set();
  return new Set<string>([
    ...manifest.pages.map((page) => page.objectId),
    ...manifest.attachments.map((item) => item.objectId).filter((id): id is string => !!id),
  ]);
}

function mergeUnique(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
