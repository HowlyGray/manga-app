/**
 * Reading a chapter without saving anything.
 *
 * Opening a chapter used to import the whole title and download every page
 * before showing a single one, so there was no way to look before committing.
 * Preview streams the pages straight from the source: nothing is written to the
 * library, and the reader offers to download once you decide to keep it.
 *
 * Page URLs are cached briefly — MangaDex hands out short-lived at-home URLs,
 * so a longer cache would serve links that have already expired.
 */
import { config } from '../config';
import { decodeId, encodeId, getProvider, type PageImage, type SourceChapter } from '../sources';
import { cachedChapters, cachedPages, rememberChapters, rememberPages } from './sourceCache';

export interface PreviewChapter {
  /** Chapter metadata, as far as the source describes it. */
  chapter: SourceChapter | null;
  pageCount: number;
}

/** Page images of a chapter, from cache when they are still fresh. */
export async function previewPages(
  titleLibraryId: string,
  chapterLibraryId: string,
): Promise<PageImage[]> {
  const cached = cachedPages<PageImage>(chapterLibraryId, config.cache.pagesMs);
  if (cached && cached.length > 0) return cached;

  const { provider: source } = decodeId(titleLibraryId);
  const { providerId } = decodeId(chapterLibraryId);
  const pages = await getProvider(source).chapterPages(providerId);
  rememberPages(chapterLibraryId, pages);
  return pages;
}

/**
 * Finds a chapter in the title's index. Preview needs the chapter's own
 * metadata (number, language, scanlator) and the source has no endpoint for a
 * single chapter, so the index is what we have.
 */
export async function previewChapterInfo(
  titleLibraryId: string,
  chapterLibraryId: string,
): Promise<SourceChapter | null> {
  const { provider: source, providerId: titleId } = decodeId(titleLibraryId);
  const provider = getProvider(source);

  let chapters = cachedChapters(titleLibraryId);
  const find = (list: SourceChapter[]) =>
    list.find((c) => encodeId(provider.id, c.id) === chapterLibraryId) ?? null;

  const hit = chapters ? find(chapters) : null;
  if (hit) return hit;

  // Not in the cached index: it may simply be stale, so refresh once.
  chapters = await provider.listChapters(titleId);
  rememberChapters(titleLibraryId, chapters);
  return find(chapters);
}
