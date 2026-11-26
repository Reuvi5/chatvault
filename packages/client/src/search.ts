/**
 * Local search.
 *
 * Search runs entirely on the device, over messages that have already been
 * decrypted for the current session. The server never sees a query, a token or
 * an index (plan §4 "Local, decrypted full-text search after unlocking", §6
 * "no server-readable tokens").
 *
 * The index is a normalised copy of the message text held in memory. It is
 * discarded when the vault is locked; nothing is written to disk.
 */
import type { CanonicalMessage } from '@chatvault/parser';

export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface SearchCorpus {
  conversationId: string;
  title: string;
  messages: readonly CanonicalMessage[];
  /** Parallel array of normalised "sender + body + file name" strings. */
  normalized: string[];
}

export function buildCorpus(
  conversationId: string,
  title: string,
  messages: readonly CanonicalMessage[],
): SearchCorpus {
  const normalized = messages.map((message) =>
    normalizeForSearch(
      `${message.sender ?? ''} ${message.body} ${message.attachmentFileName ?? ''}`,
    ),
  );
  return { conversationId, title, messages, normalized };
}

export interface SearchTerms {
  phrases: string[];
  words: string[];
  isEmpty: boolean;
}

/** Supports "quoted phrases" alongside loose words. */
export function parseQuery(query: string): SearchTerms {
  const phrases: string[] = [];
  const rest = query.replace(/"([^"]+)"/gu, (_match, phrase: string) => {
    const normalized = normalizeForSearch(phrase);
    if (normalized) phrases.push(normalized);
    return ' ';
  });
  const words = normalizeForSearch(rest).split(' ').filter(Boolean);
  return { phrases, words, isEmpty: phrases.length === 0 && words.length === 0 };
}

export interface SearchHit {
  conversationId: string;
  conversationTitle: string;
  index: number;
  message: CanonicalMessage;
  score: number;
  snippet: { before: string; match: string; after: string };
}

function snippetFor(text: string, needle: string, radius = 70): SearchHit['snippet'] {
  const normalized = normalizeForSearch(text);
  const at = needle ? normalized.indexOf(needle) : -1;
  if (at < 0) {
    return { before: text.slice(0, radius * 2), match: '', after: '' };
  }
  // Normalisation can shift offsets; approximate by proportion, then widen.
  const ratio = text.length === 0 ? 0 : at / Math.max(1, normalized.length);
  const guess = Math.max(0, Math.floor(text.length * ratio) - 8);
  const windowStart = Math.max(0, guess - radius);
  const window = text.slice(windowStart, guess + needle.length + radius);
  const localIndex = normalizeForSearch(window).indexOf(needle);
  if (localIndex < 0) return { before: window, match: '', after: '' };
  const start = windowStart + localIndex;
  return {
    before: `${windowStart > 0 ? '…' : ''}${text.slice(Math.max(0, start - radius), start)}`,
    match: text.slice(start, start + needle.length),
    after: `${text.slice(start + needle.length, start + needle.length + radius)}${
      start + needle.length + radius < text.length ? '…' : ''
    }`,
  };
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to one sender. */
  sender?: string | null;
  /** Only messages that carry an attachment. */
  attachmentsOnly?: boolean;
  /** Inclusive `YYYY-MM-DD` bounds. */
  from?: string | null;
  to?: string | null;
}

export function searchCorpora(
  corpora: readonly SearchCorpus[],
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const terms = parseQuery(query);
  const limit = options.limit ?? 200;
  const hits: SearchHit[] = [];
  const hasFilters =
    Boolean(options.sender) ||
    Boolean(options.attachmentsOnly) ||
    Boolean(options.from) ||
    Boolean(options.to);
  if (terms.isEmpty && !hasFilters) return hits;

  for (const corpus of corpora) {
    for (let index = 0; index < corpus.messages.length; index += 1) {
      const message = corpus.messages[index] as CanonicalMessage;
      if (options.sender && message.sender !== options.sender) continue;
      if (options.attachmentsOnly && !message.attachmentFileName) continue;
      if (options.from && message.localTs.slice(0, 10) < options.from) continue;
      if (options.to && message.localTs.slice(0, 10) > options.to) continue;

      const text = corpus.normalized[index] as string;
      let score = hasFilters && terms.isEmpty ? 1 : 0;
      let longest = '';

      if (!terms.isEmpty) {
        let matchedAll = true;
        for (const phrase of terms.phrases) {
          if (!text.includes(phrase)) {
            matchedAll = false;
            break;
          }
          score += 4;
          if (phrase.length > longest.length) longest = phrase;
        }
        if (matchedAll) {
          for (const word of terms.words) {
            if (!text.includes(word)) {
              matchedAll = false;
              break;
            }
            score += text.startsWith(word) ? 2 : 1;
            if (word.length > longest.length) longest = word;
          }
        }
        if (!matchedAll) continue;
      }

      hits.push({
        conversationId: corpus.conversationId,
        conversationTitle: corpus.title,
        index,
        message,
        score,
        snippet: snippetFor(message.body || message.attachmentFileName || '', longest),
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || (a.message.localTs < b.message.localTs ? 1 : -1));
  return hits.slice(0, limit);
}

/** Day boundaries for a conversation, used by "jump to date". */
export function dateIndex(
  messages: readonly CanonicalMessage[],
): Array<{ date: string; index: number }> {
  /* One entry per date, pointing at its first message. A message stamped out
     of order would otherwise list a date twice. */
  const seen = new Set<string>();
  const out: Array<{ date: string; index: number }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const date = (messages[index] as CanonicalMessage).localTs.slice(0, 10);
    if (!seen.has(date)) {
      seen.add(date);
      out.push({ date, index });
    }
  }
  return out;
}
