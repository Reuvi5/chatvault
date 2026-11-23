/**
 * JSON documents (conversation manifests, message pages) as encrypted objects.
 */
import type { ObjectKind } from '@chatvault/protocol';
import { fromUtf8, toUtf8 } from './bytes';
import {
  decryptObject,
  encryptObject,
  type ObjectStats,
} from './objectFormat';

export async function encryptJsonObject(options: {
  material: Uint8Array;
  objectId: string;
  kind: ObjectKind;
  value: unknown;
  frameSize?: number;
}): Promise<{ bytes: Uint8Array; stats: ObjectStats }> {
  return encryptObject({
    material: options.material,
    objectId: options.objectId,
    kind: options.kind,
    frameSize: options.frameSize,
    data: toUtf8(JSON.stringify(options.value)),
  });
}

export async function decryptJsonObject<T>(options: {
  material: Uint8Array;
  bytes: Uint8Array;
  expectedObjectId?: string;
}): Promise<T> {
  const plaintext = await decryptObject(options);
  return JSON.parse(fromUtf8(plaintext)) as T;
}
