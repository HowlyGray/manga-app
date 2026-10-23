import type { ChapterView } from './types';

/**
 * Which chapter of the story a row holds. A number can be stored more than
 * once -- in a second language when a better translation turned up after the
 * first was saved -- and those are one chapter to read. Chapters without a
 * number each stand alone.
 */
export function chapterKey(c: Pick<ChapterView, 'id' | 'chapter'>): string {
  return c.chapter || c.id;
}

/**
 * A key press aimed at a text box, a menu or an editable element belongs to it:
 * the reader's shortcuts must leave it alone, or the arrows that move the caret
 * through a correction would turn the page under it.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '');
}

/**
 * The chapters on either side of `currentId` in reading order. Other copies of
 * the current number are skipped, since a number stored in two languages is one
 * chapter, and of the neighbour's copies the one in the current language wins.
 */
export function neighbours(
  items: ChapterView[],
  currentId: string | undefined,
): { prev: ChapterView | null; next: ChapterView | null } {
  const at = currentId ? items.findIndex((c) => c.id === currentId) : -1;
  if (at < 0) return { prev: null, next: null };
  const current = items[at];

  // `candidates` run outward from the current chapter.
  const nearest = (candidates: ChapterView[]): ChapterView | null => {
    const first = candidates.find((c) => chapterKey(c) !== chapterKey(current));
    if (!first) return null;
    const copies = candidates.filter((c) => chapterKey(c) === chapterKey(first));
    return copies.find((c) => c.language === current.language) ?? copies[0];
  };
  return { prev: nearest(items.slice(0, at).reverse()), next: nearest(items.slice(at + 1)) };
}

export interface ReadingSummary {
  /** Where to pick up, or null when nothing was read or nothing is left. */
  next: ChapterView | null;
  /** `next` is the chapter last read, to resume, rather than a new one. */
  resuming: boolean;
  /** The last chapter read was finished and no unread one comes after it. */
  caughtUp: boolean;
  /** Chapter numbers read, and in all. */
  read: number;
  total: number;
}

/**
 * Where to continue a title, from its chapters in reading order and the chapter
 * read most recently: that chapter while unfinished, then the next chapter
 * number not read yet -- in the same language when it exists in it.
 */
export function summarizeReading(items: ChapterView[], lastChapterId: string | null | undefined): ReadingSummary {
  const finished = new Set(items.filter((c) => c.read?.finished).map(chapterKey));
  const total = new Set(items.map(chapterKey)).size;
  const at = lastChapterId ? items.findIndex((c) => c.id === lastChapterId) : -1;
  const last = at >= 0 ? items[at] : null;
  const summary = { read: finished.size, total };
  if (!last) return { next: null, resuming: false, caughtUp: false, ...summary };
  if (!last.read?.finished) return { next: last, resuming: true, caughtUp: false, ...summary };

  const unread = items.slice(at + 1).filter((c) => !finished.has(chapterKey(c)));
  const copies = unread.filter((c) => chapterKey(c) === chapterKey(unread[0] ?? last));
  const next = copies.find((c) => c.language === last.language) ?? copies[0] ?? null;
  return { next, resuming: false, caughtUp: next === null, ...summary };
}
