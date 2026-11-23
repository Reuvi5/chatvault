/**
 * Logging.
 *
 * Plan §6: "No plaintext exports, decrypted thumbnails, or decryption keys in
 * server logs, error reports, analytics, email, support tickets, or crash
 * telemetry." The redaction below is a safety net, not a licence to log
 * sensitive values: fields whose names suggest secrets are dropped, long
 * strings are truncated, and byte arrays are reduced to their length.
 */

const SENSITIVE_KEY = /(secret|token|ticket|password|passphrase|bundle|cookie|authorization|key)$/iu;
const MAX_STRING = 200;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${String(value.length)} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const length = value instanceof Uint8Array ? value.byteLength : value.byteLength;
    return `[${String(length)} bytes]`;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message) };
  }
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }
  return '[unloggable]';
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    message,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const throttled = new Map<string, number>();

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => {
    if (process.env.CHATVAULT_DEBUG) emit('debug', message, fields);
  },
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),

  /**
   * For conditions that repeat once per object during an incident — a provider
   * being unreachable, say. One line a minute per key says the same thing
   * without burying everything else.
   */
  warnThrottled: (
    key: string,
    message: string,
    fields?: Record<string, unknown>,
    everyMs = 60_000,
  ) => {
    const now = Date.now();
    const last = throttled.get(key) ?? 0;
    if (now - last < everyMs) return;
    throttled.set(key, now);
    emit('warn', message, fields);
  },
};
