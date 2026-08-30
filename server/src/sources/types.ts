/**
 * Contract every content source implements.
 *
 * MangaDex used to be called directly from the ingest and download paths, which
 * made it the only possible source. It is now one provider behind this
 * interface: the rest of the app talks in `SourceTitle` / `SourceChapter` and
 * never knows where a page came from.
 */

export interface SourceTitle {
  /** Identifier within the provider, not the library's key. */
  id: string;
  title: string;
  altTitles: string[];
  originalLang: string | null;
  synopsis: string | null;
  status: string | null;
  year: number | null;
  author: string | null;
  contentRating: string | null;
  tags: string[];
  /** Absolute cover URL, or null when the provider has none. */
  coverUrl: string | null;
}

export interface SourceChapter {
  id: string;
  /** Chapter number as printed; providers are inconsistent, so keep the text. */
  chapter: string | null;
  title: string | null;
  volume: string | null;
  /** MangaDex-style language code (`en`, `pt-br`, `ja`, …). */
  language: string;
  pages: number | null;
  scanlator: string | null;
  publishedAt: string | null;
  /** Set when the chapter only exists on an external site; not downloadable. */
  externalUrl: string | null;
}

export interface SourceSearch {
  q?: string;
  /** Original language filter, when the provider supports one. */
  lang?: string;
  limit?: number;
  offset?: number;
}

/** One page image. Some providers need a referer or other headers to serve it. */
export interface PageImage {
  url: string;
  headers?: Record<string, string>;
}

export interface SourceProvider {
  /** Stable key, also used to prefix library ids. */
  readonly id: string;
  /** Name shown in the UI. */
  readonly label: string;
  /** True when the provider can list titles without a search term. */
  readonly browsable: boolean;

  search(params: SourceSearch): Promise<{ total: number; titles: SourceTitle[] }>;
  getTitle(id: string): Promise<SourceTitle | null>;
  /**
   * Chapters for a title, already reduced to one per chapter number in the
   * language the pipeline reads best.
   */
  listChapters(titleId: string): Promise<SourceChapter[]>;
  /** Page images of a chapter, in reading order. */
  chapterPages(chapterId: string): Promise<PageImage[]>;
  /** Fetches one image, applying whatever headers the provider requires. */
  fetchImage(image: PageImage): Promise<Response>;
}
