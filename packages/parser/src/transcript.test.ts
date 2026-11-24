import { describe, expect, it } from 'vitest';
import { interpretBody, parseTranscript } from './transcript';
import { buildSyntheticExport } from './synthetic';

describe('iOS transcripts', () => {
  const text = [
    '\u200e[17/11/2026, 9:40:00\u202fAM] Messages and calls are end-to-end encrypted. Only people in this chat can read them.',
    '\u200e[17/11/2026, 9:41:03\u202fAM] Dana Okonkwo: Morning! Are we still on for Thursday?',
    '\u200e[17/11/2026, 9:41:40\u202fAM] Sam Reyes: Yes — 7pm at the usual place',
    '\u200e[17/11/2026, 9:42:10\u202fAM] Dana Okonkwo: \u200e<attached: 00000042-PHOTO-2026-11-17-09-42-10.jpg>',
    '\u200e[17/11/2026, 9:43:00\u202fAM] Sam Reyes: Lovely 😍',
  ].join('\n');

  const parsed = parseTranscript(text);

  it('separates system notices from messages', () => {
    expect(parsed.counts.system).toBe(1);
    expect(parsed.counts.messages).toBe(4);
    expect(parsed.messages[0]?.kind).toBe('system');
    expect(parsed.messages[0]?.sender).toBeNull();
  });

  it('keeps senders, bodies and second-level precision', () => {
    expect(parsed.messages[1]).toMatchObject({
      kind: 'message',
      sender: 'Dana Okonkwo',
      body: 'Morning! Are we still on for Thursday?',
      localTs: '2026-11-17T09:41:03',
      tsPrecision: 'second',
    });
  });

  it('extracts attachment file names and leaves the body empty', () => {
    expect(parsed.messages[3]).toMatchObject({
      attachmentFileName: '00000042-PHOTO-2026-11-17-09-42-10.jpg',
      body: '',
    });
    expect(parsed.referencedFiles).toEqual(['00000042-PHOTO-2026-11-17-09-42-10.jpg']);
  });

  it('records participants in first-seen order and detects a one-to-one chat', () => {
    expect(parsed.participants).toEqual(['Dana Okonkwo', 'Sam Reyes']);
    expect(parsed.isGroup).toBe(false);
  });

  it('preserves emoji', () => {
    expect(parsed.messages[4]?.body).toBe('Lovely 😍');
  });
});

describe('Android transcripts', () => {
  const text = [
    '17/11/2026, 09:40 - Messages and calls are end-to-end encrypted.',
    '17/11/2026, 09:41 - Dana Okonkwo: Morning!',
    '17/11/2026, 09:42 - Sam Reyes: IMG-20261117-WA0003.jpg (file attached)',
    '17/11/2026, 09:43 - Sam Reyes: <Media omitted>',
    '17/11/2026, 09:44 - Dana Okonkwo: This message was deleted',
    '17/11/2026, 09:45 - Dana Okonkwo: Final answer <This message was edited>',
  ].join('\r\n');

  const parsed = parseTranscript(text);

  it('handles carriage returns and minute-only precision', () => {
    expect(parsed.counts.total).toBe(6);
    expect(parsed.messages[1]?.tsPrecision).toBe('minute');
    expect(parsed.warnings.some((w) => w.code === 'minute_precision')).toBe(true);
  });

  it('reads the Android attachment marker', () => {
    expect(parsed.messages[2]?.attachmentFileName).toBe('IMG-20261117-WA0003.jpg');
  });

  it('flags omitted media, deletions and edits', () => {
    expect(parsed.messages[3]?.flags.mediaOmitted).toBe(true);
    expect(parsed.messages[4]?.flags.deleted).toBe(true);
    expect(parsed.messages[5]).toMatchObject({ body: 'Final answer', flags: { edited: true } });
    expect(parsed.warnings.some((w) => w.code === 'media_omitted')).toBe(true);
  });
});

describe('awkward real-world cases', () => {
  it('joins multi-line messages without losing the line breaks', () => {
    const parsed = parseTranscript(
      [
        '17/11/2026, 09:41 - Dana: Here is the plan:',
        'first the route',
        'then the food',
        '',
        'and the budget at the end',
        '17/11/2026, 09:42 - Sam: Perfect',
      ].join('\n'),
    );
    expect(parsed.counts.total).toBe(2);
    expect(parsed.messages[0]?.body).toBe(
      'Here is the plan:\nfirst the route\nthen the food\n\nand the budget at the end',
    );
  });

  it('treats a notice containing a colon as a notice, not a message', () => {
    const parsed = parseTranscript(
      [
        '17/11/2026, 09:40 - Dana Okonkwo created group "Lake trip": summer edition',
        '17/11/2026, 09:41 - Dana Okonkwo: first!',
        '17/11/2026, 09:42 - Dana Okonkwo changed the subject to Lake trip: final',
      ].join('\n'),
    );
    expect(parsed.messages[0]?.kind).toBe('system');
    expect(parsed.messages[1]).toMatchObject({ kind: 'message', sender: 'Dana Okonkwo' });
    expect(parsed.messages[2]?.kind).toBe('system');
  });

  it('does not mistake a message that merely mentions a system verb', () => {
    const parsed = parseTranscript(
      [
        '17/11/2026, 09:41 - Dana: added you to the shared album',
        '17/11/2026, 09:42 - Dana: left the keys under the mat',
      ].join('\n'),
    );
    expect(parsed.counts.messages).toBe(2);
    expect(parsed.participants).toEqual(['Dana']);
  });

  it('keeps right-to-left text intact', () => {
    const parsed = parseTranscript('17/11/2026, 09:41 - דנה: שלום, מה המצב?\n');
    expect(parsed.messages[0]).toMatchObject({ sender: 'דנה', body: 'שלום, מה המצב?' });
  });

  it('accepts a byte-order mark at the start of the file', () => {
    const parsed = parseTranscript('\ufeff17/11/2026, 09:41 - Dana: hi\n');
    expect(parsed.counts.messages).toBe(1);
  });

  it('counts lines it cannot explain instead of discarding them silently', () => {
    const parsed = parseTranscript(
      ['some export preamble', 'another stray line', '17/11/2026, 09:41 - Dana: hi'].join('\n'),
    );
    expect(parsed.counts.unparsed).toBe(2);
    const warning = parsed.warnings.find((w) => w.code === 'unparsed_lines');
    expect(warning?.count).toBe(2);
    expect(warning?.samples?.[0]).toBe('some export preamble');
  });

  it('does not treat a pasted log line inside a message as a new message', () => {
    const parsed = parseTranscript(
      ['17/11/2026, 09:41 - Dana: see the log:', '17/11/2026 ERROR something broke'].join('\n'),
    );
    expect(parsed.counts.total).toBe(1);
    expect(parsed.messages[0]?.body).toContain('ERROR something broke');
  });

  it('reports an empty file rather than pretending to succeed', () => {
    const parsed = parseTranscript('');
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.warnings.some((w) => w.code === 'empty_transcript')).toBe(true);
  });

  it('honours a date order chosen in the preview screen', () => {
    const text = '03/04/2026, 09:41 - Dana: hi\n';
    expect(parseTranscript(text).messages[0]?.localTs).toBe('2026-04-03T09:41:00');
    expect(parseTranscript(text, { dateOrder: 'mdy' }).messages[0]?.localTs).toBe(
      '2026-03-04T09:41:00',
    );
  });

  it('warns when the date order had to be assumed', () => {
    const parsed = parseTranscript('03/04/2026, 09:41 - Dana: hi\n');
    expect(parsed.dateOrderConfidence).toBe('assumed');
    expect(parsed.warnings.some((w) => w.code === 'date_order_assumed')).toBe(true);
  });

  it('never claims the history is complete', () => {
    const parsed = parseTranscript('17/11/2026, 09:41 - Dana: hi\n');
    expect(parsed.warnings.some((w) => w.code === 'history_may_be_partial')).toBe(true);
    expect(parsed.warnings.some((w) => w.code === 'timezone_unknown')).toBe(true);
  });

  it('stops at the message cap', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i += 1)
      lines.push(`17/11/2026, 09:${String(i % 60).padStart(2, '0')} - Dana: ${String(i)}`);
    const parsed = parseTranscript(lines.join('\n'), { maxMessages: 10 });
    expect(parsed.counts.total).toBe(10);
  });
});

describe('body interpretation', () => {
  it('reads both attachment markers and ignores a sentence that just ends that way', () => {
    expect(interpretBody('<attached: IMG_0001.jpg>').attachmentFileName).toBe('IMG_0001.jpg');
    expect(interpretBody('IMG-20261117-WA0001.jpg (file attached)').attachmentFileName).toBe(
      'IMG-20261117-WA0001.jpg',
    );
    expect(
      interpretBody('I sent the contract over email (file attached)').attachmentFileName,
    ).toBeNull();
  });

  it('recognises every omitted-media placeholder we have seen', () => {
    for (const body of [
      '<Media omitted>',
      'image omitted',
      'video omitted',
      'audio omitted',
      'sticker omitted',
      'GIF omitted',
      'document omitted',
      'voice message omitted',
    ]) {
      expect(interpretBody(body).flags.mediaOmitted, body).toBe(true);
    }
  });

  it('strips edit markers and the invisible characters around media markers', () => {
    expect(interpretBody('Hello <This message was edited>')).toMatchObject({
      body: 'Hello',
      flags: { edited: true },
    });
    expect(interpretBody('\u200e<attached: a.jpg>\u200e').attachmentFileName).toBe('a.jpg');
  });
});

describe('generated fixtures parse cleanly', () => {
  it.each([
    ['ios', true, false],
    ['ios', false, true],
    ['android', true, true],
    ['android', false, false],
  ] as const)('platform %s, media %s, group %s', (platform, withMedia, group) => {
    const fixture = buildSyntheticExport({
      platform,
      withMedia,
      group,
      messageCount: 60,
      seed: 7,
    });
    const parsed = parseTranscript(fixture.transcript);
    expect(parsed.counts.total).toBe(fixture.expected.messageCount);
    expect(parsed.counts.unparsed).toBe(0);
    expect(parsed.isGroup).toBe(group);
    for (const member of fixture.expected.participants) {
      expect(parsed.participants).toContain(member);
    }
    if (withMedia) {
      expect(parsed.referencedFiles.length).toBe(fixture.mediaFileNames.length);
    } else {
      expect(parsed.counts.mediaOmitted).toBeGreaterThan(0);
    }
  });

  it('reads a US-style month-first export correctly', () => {
    const fixture = buildSyntheticExport({
      platform: 'android',
      dateOrder: 'mdy',
      clock: '12h',
      withMedia: false,
      startDate: { year: 2026, month: 3, day: 7 },
      messageCount: 80,
      seed: 11,
    });
    const parsed = parseTranscript(fixture.transcript);
    expect(parsed.dateOrder).toBe('mdy');
    expect(parsed.dateOrderConfidence).toBe('certain');
    expect(parsed.firstLocalTs?.startsWith('2026-03-07')).toBe(true);
  });
});
