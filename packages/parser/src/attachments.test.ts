import { describe, expect, it } from 'vitest';
import {
  inferTitleAndSelf,
  matchAttachments,
  normalizeFileName,
  pickTranscriptEntry,
  titleFromFileName,
} from './attachments';

describe('file name normalisation', () => {
  it('drops directories, invisible marks and case', () => {
    expect(normalizeFileName('folder/sub/IMG_0001.JPG')).toBe('img_0001.jpg');
    expect(normalizeFileName('\u200eIMG_0001.jpg ')).toBe('img_0001.jpg');
    expect(normalizeFileName('folder\\windows.png')).toBe('windows.png');
  });
});

describe('matching transcript references to archive members', () => {
  it('matches exactly, case-insensitively and across separator styles', () => {
    const result = matchAttachments(
      ['IMG_0001.JPG', '\u200eIMG-0002.jpg', 'IMG 0003.jpg', 'missing.jpg'],
      ['img_0001.jpg', 'IMG_0002.jpg', 'IMG-0003.jpg', 'nobody-asked-for-this.png'],
    );
    expect(result.matched.get('IMG_0001.JPG')).toBe('img_0001.jpg');
    expect(result.matched.get('\u200eIMG-0002.jpg')).toBe('IMG_0002.jpg');
    expect(result.matched.get('IMG 0003.jpg')).toBe('IMG-0003.jpg');
    expect(result.missing).toEqual(['missing.jpg']);
    expect(result.unreferenced).toEqual(['nobody-asked-for-this.png']);
  });

  it('does not reuse one archive member for two references', () => {
    const result = matchAttachments(['a.jpg', 'a.jpg'], ['a.jpg']);
    expect(result.matched.size).toBe(1);
    expect(result.unreferenced).toEqual([]);
  });
});

describe('title inference', () => {
  it('reads the usual export file names', () => {
    expect(titleFromFileName('WhatsApp Chat with Dana Okonkwo.txt')).toBe('Dana Okonkwo');
    expect(titleFromFileName('WhatsApp Chat - Lake trip planning.zip')).toBe('Lake trip planning');
    expect(titleFromFileName('Chat de WhatsApp con Dana.txt')).toBe('WhatsApp con Dana');
    expect(titleFromFileName('_chat.txt')).toBeNull();
  });

  it('works out which participant is the person importing, in a one-to-one chat', () => {
    const guess = inferTitleAndSelf({
      sourceFileName: 'WhatsApp Chat with Sam Reyes.zip',
      participants: ['Dana Okonkwo', 'Sam Reyes'],
      isGroup: false,
    });
    expect(guess).toEqual({ title: 'Sam Reyes', selfName: 'Dana Okonkwo', confidence: 'certain' });
  });

  it('does not guess at "me" in a group chat', () => {
    const guess = inferTitleAndSelf({
      sourceFileName: 'WhatsApp Chat - Lake trip.zip',
      participants: ['Dana', 'Sam', 'Priya'],
      isGroup: true,
    });
    expect(guess.title).toBe('Lake trip');
    expect(guess.selfName).toBeNull();
  });

  it('falls back to participant names when the file name says nothing', () => {
    expect(
      inferTitleAndSelf({ sourceFileName: '_chat.txt', participants: ['Dana', 'Sam'], isGroup: false }),
    ).toMatchObject({ title: 'Dana & Sam', confidence: 'assumed' });
    expect(
      inferTitleAndSelf({
        sourceFileName: '_chat.txt',
        participants: ['A', 'B', 'C', 'D', 'E'],
        isGroup: true,
      }),
    ).toMatchObject({ title: 'A, B, C +2' });
  });

  it('has something to show even for an empty export', () => {
    expect(
      inferTitleAndSelf({ sourceFileName: '_chat.txt', participants: [], isGroup: false }).title,
    ).toBe('Untitled conversation');
  });
});

describe('choosing the transcript inside an archive', () => {
  it('prefers _chat.txt', () => {
    expect(pickTranscriptEntry(['IMG_1.jpg', '_chat.txt', 'notes.txt']).name).toBe('_chat.txt');
  });

  it('falls back to a chat-like name, then to the first text file', () => {
    expect(pickTranscriptEntry(['notes.txt', 'WhatsApp Chat with Dana.txt']).name).toBe(
      'WhatsApp Chat with Dana.txt',
    );
    expect(pickTranscriptEntry(['notes.txt', 'other.txt']).name).toBe('notes.txt');
    expect(pickTranscriptEntry(['IMG_1.jpg'])).toEqual({ name: null, candidates: [] });
  });
});
