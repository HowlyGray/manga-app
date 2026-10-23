import { describe, expect, it } from 'vitest';
import { isTypingTarget, neighbours, summarizeReading } from './reading';
import type { ChapterView } from './types';

function ch(id: string, chapter: string | null, read?: { page: number; finished: boolean }, language = 'en'): ChapterView {
  return {
    id,
    chapter,
    title: null,
    volume: null,
    language,
    pages: 10,
    scanlator: null,
    publishedAt: null,
    downloaded: 0,
    downloadError: null,
    read: read ? { ...read, pages: 10 } : null,
  };
}

const done = { page: 10, finished: true };
const half = { page: 4, finished: false };

describe('where to continue a title', () => {
  it('has nowhere to continue before anything was read', () => {
    expect(summarizeReading([ch('a', '1'), ch('b', '2')], null)).toMatchObject({
      next: null,
      caughtUp: false,
      read: 0,
      total: 2,
    });
  });

  it('resumes the chapter last read while it is unfinished', () => {
    const items = [ch('a', '1', done), ch('b', '2', half), ch('c', '3')];
    expect(summarizeReading(items, 'b')).toMatchObject({ next: { id: 'b' }, resuming: true, read: 1 });
  });

  it('moves on to the next chapter number, not to another copy of the same one', () => {
    const items = [ch('a', '1'), ch('b-en', '2', done), ch('b-es', '2', undefined, 'es'), ch('c', '3')];
    expect(summarizeReading(items, 'b-en')).toMatchObject({ next: { id: 'c' }, resuming: false });
  });

  it('prefers the language just read when the next number exists in several', () => {
    const items = [
      ch('a-es', '1', done, 'es'),
      ch('b-en', '2'),
      ch('b-es', '2', undefined, 'es'),
    ];
    expect(summarizeReading(items, 'a-es').next?.id).toBe('b-es');
  });

  it('skips chapters already read', () => {
    const items = [ch('a', '1', done), ch('b', '2', done), ch('c', '3')];
    expect(summarizeReading(items, 'a').next?.id).toBe('c');
  });

  it('is caught up when no unread chapter comes after the last one read', () => {
    const items = [ch('a', '1'), ch('b', '2', done)];
    expect(summarizeReading(items, 'b')).toMatchObject({ next: null, caughtUp: true });
  });

  it('counts chapter numbers rather than stored copies', () => {
    const items = [
      ch('a', '1', done),
      ch('b-en', '2', done),
      ch('b-es', '2', done, 'es'),
      ch('c-en', '3'),
      ch('c-es', '3', undefined, 'es'),
      ch('x', null),
      ch('y', null, done),
    ];
    expect(summarizeReading(items, 'a')).toMatchObject({ read: 3, total: 5 });
  });
});

describe('the chapters either side of the one being read', () => {
  it('are the previous and next chapter numbers', () => {
    const items = [ch('a', '1'), ch('b', '2'), ch('c', '3')];
    expect(neighbours(items, 'b')).toMatchObject({ prev: { id: 'a' }, next: { id: 'c' } });
  });

  it('stop at the ends of the list', () => {
    const items = [ch('a', '1'), ch('b', '2')];
    expect(neighbours(items, 'a')).toEqual({ prev: null, next: expect.objectContaining({ id: 'b' }) });
    expect(neighbours(items, 'b')).toEqual({ prev: expect.objectContaining({ id: 'a' }), next: null });
  });

  it('skip the other copies of the chapter being read', () => {
    // Pressing "next" on 2 used to land on 2 again, in its other language.
    const items = [ch('a', '1'), ch('b-en', '2'), ch('b-es', '2', undefined, 'es'), ch('c', '3')];
    expect(neighbours(items, 'b-en')).toMatchObject({ prev: { id: 'a' }, next: { id: 'c' } });
    expect(neighbours(items, 'b-es')).toMatchObject({ prev: { id: 'a' }, next: { id: 'c' } });
  });

  it('take the neighbour in the language being read when it has one', () => {
    const items = [
      ch('a-en', '1'),
      ch('a-es', '1', undefined, 'es'),
      ch('b-es', '2', undefined, 'es'),
      ch('c-en', '3'),
      ch('c-es', '3', undefined, 'es'),
    ];
    expect(neighbours(items, 'b-es')).toMatchObject({ prev: { id: 'a-es' }, next: { id: 'c-es' } });
  });

  it('treat each chapter without a number as its own', () => {
    const items = [ch('x', null), ch('y', null), ch('a', '1')];
    expect(neighbours(items, 'x')).toMatchObject({ prev: null, next: { id: 'y' } });
    expect(neighbours(items, 'y')).toMatchObject({ prev: { id: 'x' }, next: { id: 'a' } });
  });

  it('have nothing for a chapter that is not in the list', () => {
    expect(neighbours([ch('a', '1')], 'zzz')).toEqual({ prev: null, next: null });
    expect(neighbours([ch('a', '1')], undefined)).toEqual({ prev: null, next: null });
  });
});

describe('keys aimed at a form control', () => {
  it('are left to it', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true);
    }
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not compute isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
  });

  it('belong to the reader anywhere else', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
