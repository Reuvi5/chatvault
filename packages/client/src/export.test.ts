import { describe, expect, it } from 'vitest';
import { buildSyntheticExport, mergeMessages, parseTranscript } from '@chatvault/parser';
import { renderTranscript } from './export';

describe('the readable export round-trips through our own parser', () => {
  it.each([
    ['ios', true],
    ['android', false],
  ] as const)('platform %s, media %s', (platform, withMedia) => {
    const fixture = buildSyntheticExport({ platform, withMedia, messageCount: 60, seed: 51 });
    const original = parseTranscript(fixture.transcript).messages;

    const rendered = renderTranscript(original);
    const reparsed = parseTranscript(rendered).messages;

    expect(reparsed).toHaveLength(original.length);
    expect(reparsed.map((message) => message.localTs)).toEqual(
      original.map((message) => message.localTs),
    );
    expect(reparsed.map((message) => message.sender)).toEqual(
      original.map((message) => message.sender),
    );
    expect(reparsed.map((message) => message.body)).toEqual(
      original.map((message) => message.body),
    );
    expect(reparsed.map((message) => message.attachmentFileName)).toEqual(
      original.map((message) => message.attachmentFileName),
    );
  });

  it('is recognised as a duplicate if it is imported back into the same archive', () => {
    const fixture = buildSyntheticExport({
      platform: 'ios',
      withMedia: false,
      messageCount: 40,
      seed: 52,
    });
    const archived = parseTranscript(fixture.transcript).messages;
    const reimported = parseTranscript(renderTranscript(archived)).messages;

    const merge = mergeMessages(archived, reimported);
    expect(merge.added).toBe(0);
    expect(merge.duplicatesSkipped).toBe(archived.length);
  });

  it('keeps edit markers and omitted-media placeholders', () => {
    const transcript = [
      '17/11/2026, 09:41 - Dana: Final answer <This message was edited>',
      '17/11/2026, 09:42 - Dana: <Media omitted>',
      '17/11/2026, 09:43 - Messages and calls are end-to-end encrypted.',
    ].join('\n');
    const parsed = parseTranscript(transcript).messages;
    const reparsed = parseTranscript(renderTranscript(parsed)).messages;

    expect(reparsed[0]?.flags.edited).toBe(true);
    expect(reparsed[0]?.body).toBe('Final answer');
    expect(reparsed[1]?.flags.mediaOmitted).toBe(true);
    expect(reparsed[2]?.kind).toBe('system');
  });
});
