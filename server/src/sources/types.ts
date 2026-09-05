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

/** How a result set is ordered. Providers map these onto their own vocabulary. */
export type SearchSort = 'popular' | 'latest' | 'newest' | 'rating' | 'relevance' | 'title';

export interface SourceSearch {
  q?: string;
  /** Original language filter, when the provider supports one. */
  lang?: string;
  limit?: number;
  offset?: number;
  /** Tag ids from `listTags`; a title must carry all of them. */
  tags?: string[];
  sort?: SearchSort;
  /** ISO timestamp; only titles added to the source after it. */
  createdSince?: string;
}

/** A genre, theme or format a source can filter by. */
export interface SourceTag {
  id: string;
  name: string;
  /** `genre`, `theme`, `format`, `content`, … — used to group the picker. */
  group: string;
}

/** A row of titles on the home page. */
export interface SourceShelf {
  id: string;
  title: string;
  /** One line explaining what the row actually ranks. */
  subtitle: string;
  titles: SourceTitle[];
  /** Filters that reproduce this shelf in the browse view, when they exist. */
  browse?: Pick<SourceSearch, 'sort' | 'createdSince'>;
}

/** One page image. Some providers need a referer or other headers to serve it. */
export interface PageImage {
  url: string;
  headers?: Record<string, string>;
}

export interface SourceSearchResult {
  titles: SourceTitle[];
  /**
   * Total matches, or null when the provider does not report one. A null total
   * is not a failure: some sources simply paginate blind, and the UI then shows
   * a next/previous pager instead of a numbered one.
   */
  total: number | null;
}

export interface SourceProvider {
  /** Stable key, also used to prefix library ids. */
  readonly id: string;
  /** Name shown in the UI. */
  readonly label: string;
  /** True when the provider can list titles without a search term. */
  readonly browsable: boolean;
  /**
   * Largest offset the provider will accept, or null when unbounded. MangaDex
   * rejects anything past 10000 with a 400, so a pager built from the raw total
   * would offer thousands of pages that cannot be fetched.
   */
  readonly maxOffset: number | null;

  search(params: SourceSearch): Promise<SourceSearchResult>;
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

  /** Tags this source can filter by. Absent when it offers no tag browsing. */
  listTags?(): Promise<SourceTag[]>;
  /** Rows for the home page. Absent when the source has nothing to feature. */
  homeShelves?(): Promise<SourceShelf[]>;
}
