/**
 * Object routes: authorize, receive parts, complete, authorize a read, stream
 * ciphertext back.
 *
 * Every one of these resolves the session first and then checks the ticket
 * against that account, so a valid ticket from one account is useless on
 * another's object, and a valid session cannot reach an object it does not own.
 */
import {
  completeObjectRequest,
  uploadAuthorizeRequest,
} from '@chatvault/protocol';
import { getStore } from '../db/index';
import {
  badRequest,
  clientHash,
  emptyResponse,
  jsonResponse,
  parseBody,
  payloadTooLarge,
} from '../http';
import { requireVerifiedSession } from '../auth/session';
import { enforceRateLimit } from '../security';
import { getEnv } from '../env';
import {
  authorizeDownload,
  authorizeUpload,
  completeObject,
  openObjectStream,
  receivePart,
} from '../services/objects';
import { getPrimaryDriver } from '../objects/index';

const TICKET_HEADER = 'x-chatvault-ticket';

export async function handleAuthorizeUpload(request: Request): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`upload:${account.id}`, getEnv().rateLimits.upload);
  const input = await parseBody(request, uploadAuthorizeRequest);
  const store = await getStore();
  const result = await store.transaction(account.id, (tx) =>
    authorizeUpload(tx, account, input),
  );
  return jsonResponse(result, { status: 201 });
}

export async function handleUploadPart(
  request: Request,
  objectId: string,
  partText: string,
): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`upload:${account.id}`, getEnv().rateLimits.upload);

  const partNumber = Number(partText);
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    throw badRequest('That part number is not valid.');
  }

  // Accept a little more than one part, so a slightly larger final frame fits.
  const ceiling = getPrimaryDriver().partSizeBytes + 1024 * 1024;
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > ceiling) {
    throw payloadTooLarge('That upload part is larger than the agreed part size.');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > ceiling) {
    throw payloadTooLarge('That upload part is larger than the agreed part size.');
  }

  const store = await getStore();
  const result = await store.transaction(account.id, (tx) =>
    receivePart(tx, account.id, {
      objectId,
      partNumber,
      ticket: request.headers.get(TICKET_HEADER),
      bytes,
    }),
  );
  return jsonResponse(result);
}

export async function handleCompleteObject(request: Request): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`upload:${account.id}`, getEnv().rateLimits.upload);
  const input = await parseBody(request, completeObjectRequest);
  const store = await getStore();
  const verdict = await store.transaction(account.id, (tx) =>
    completeObject(tx, account, { ...input, clientHash: clientHash(request) }),
  );
  if (verdict.status === 'rejected') {
    throw badRequest(`That upload was not accepted: ${verdict.reason}`);
  }
  return jsonResponse(verdict.object);
}

export async function handleAuthorizeDownload(
  request: Request,
  objectId: string,
): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`read:${account.id}`, getEnv().rateLimits.read);
  const store = await getStore();
  const result = await store.transaction(account.id, (tx) =>
    authorizeDownload(tx, account.id, objectId),
  );
  return jsonResponse(result);
}

export async function handleObjectContent(
  request: Request,
  objectId: string,
): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  enforceRateLimit(`read:${account.id}`, getEnv().rateLimits.read);
  const store = await getStore();
  const ticket = request.headers.get(TICKET_HEADER) ?? new URL(request.url).searchParams.get('ticket');
  const { stream, bytes, servedBy } = await openObjectStream(store, account.id, objectId, ticket);

  return new Response(stream as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      ...(bytes > 0 ? { 'content-length': String(bytes) } : {}),
      'cache-control': 'no-store',
      'x-chatvault-served-by': servedBy,
      // Ciphertext is opaque; make sure nothing tries to interpret it.
      'x-content-type-options': 'nosniff',
      'content-disposition': 'attachment',
    },
  });
}

export async function handleHeadObject(
  request: Request,
  objectId: string,
): Promise<Response> {
  const { account } = await requireVerifiedSession(request);
  const store = await getStore();
  const object = await store.get('objects', objectId);
  if (!object || object.account_id !== account.id) return emptyResponse({ status: 404 });
  return emptyResponse({
    headers: {
      'content-length': String(object.ciphertext_bytes),
      'x-chatvault-state': object.state,
    },
  });
}
