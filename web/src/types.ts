export interface DiscoverItem {
  id: string;
  /** Provider the result came from. */
  source?: string;
  title: string;
  altTitles: string[];
  originalLanguage: string | null;
  year: number | null;
  status: string | null;
  tags: string[];
  coverUrl: string | null;
  isSaved: boolean;
}

export interface DiscoverResponse {
  /** Matching titles, or null when the source reports no count. */
  total: number | null;
  page: number;
  limit: number;
  /** Addressable pages; 0 when unknown. */
  pages: number;
  hasMore: boolean;
  source: string;
  titles: DiscoverItem[];
}

export interface SourceInfo {
  id: string;
  label: string;
  browsable: boolean;
  /** The source can filter by genre/theme tags. */
  hasTags: boolean;
  /** The source has featured rows for the home page. */
  hasShelves: boolean;
}

export interface Tag {
  id: string;
  name: string;
  /** `genre`, `theme`, `format`, `content`. */
  group: string;
}

export type SearchSort = 'popular' | 'latest' | 'newest' | 'rating' | 'relevance' | 'title';

export interface Shelf {
  id: string;
  title: string;
  subtitle: string;
  /** Filters that reproduce the shelf in the browse view. */
  browse: { sort?: SearchSort; createdSince?: string } | null;
  titles: DiscoverItem[];
}

export interface HomeResponse {
  source: string;
  shelves: Shelf[];
}

export interface LibraryTitle {
  id: string;
  provider: string;
  provider_id: string;
  title: string;
  alt_titles: string[];
  original_lang: string | null;
  synopsis: string | null;
  status: string | null;
  year: number | null;
  author: string | null;
  content_rating: string | null;
  tags: string[];
  cover_local: string | null;
  jikan_score: number | null;
  /** Chapter numbers; a number stored in two languages counts once. */
  total_chapters: number;
  downloaded_chapters: number;
  /** Chapter numbers marked finished. */
  read_chapters: number;
  /** Chapter numbers added since the title was last opened. */
  new_chapters: number;
  progress_chapter_id: string | null;
  progress_page: number;
}

/** How far one chapter has been read. */
export interface ChapterRead {
  page: number;
  pages: number | null;
  finished: boolean;
}

export interface ChapterView {
  id: string;
  chapter: string | null;
  title: string | null;
  volume: string | null;
  language: string;
  /** Human-readable name of the language printed on the pages. */
  languageLabel?: string;
  pages: number | null;
  scanlator: string | null;
  publishedAt: string | null;
  downloaded: number;
  downloadError: string | null;
  /** Null until the chapter has been opened; absent in reader payloads. */
  read?: ChapterRead | null;
  /** Added since the title was last opened (library titles only). */
  isNew?: boolean;
}

/** Bytes on disk for a title, by kind. */
export interface Usage {
  pages: number;
  translations: number;
  ocr: number;
}

/** The library-wide check for new chapters. */
export interface UpdateCheck {
  running: boolean;
  total: number;
  checked: number;
  found: number;
  failed: { id: string; title: string; error: string }[];
  startedAt: string | null;
  finishedAt: string | null;
}

/** What refreshing one saved title found. */
export interface RefreshResult {
  /** False when the title was checked a moment ago and the source was not asked again. */
  refreshed: boolean;
  /** Chapters stored for the first time. */
  added: number;
  /** Of those, translations that read better than the copy already held under their number. */
  upgrades: number;
  /** Ids of those that are news. */
  fresh: string[];
  /** Chapter numbers among them, counted the way the library badges count. */
  news: number;
  detailsChanged: boolean;
  incremental: boolean;
  checkedAt: string | null;
}

export interface Progress {
  title_id: string;
  chapter_id: string | null;
  page: number;
  pages?: number | null;
  finished?: boolean;
  mode: string;
}

export interface TitleView {
  id: string;
  provider: string;
  provider_id: string;
  title: string;
  alt_titles: string[];
  original_lang: string | null;
  synopsis: string | null;
  status: string | null;
  year: number | null;
  author: string | null;
  content_rating: string | null;
  tags: string[];
  jikan_score: number | null;
  cover_local?: string | null;
}

export interface TitleDetailResponse {
  inLibrary: boolean;
  /** When the source was last asked about this title; saved titles only. */
  checkedAt?: string | null;
  coverUrl: string | null;
  title: TitleView;
  languages: string[];
  chapters: { total: number; items: ChapterView[] };
  progress: Progress | null;
}

export interface DownloadStatus {
  running: boolean;
  total: number;
  downloaded: number;
  failed: number;
  pending: number;
}

export interface PageView {
  pageNumber: number;
  downloaded: number;
  url: string;
}

export interface ChapterDetailResponse {
  /** True when the pages stream from the source and nothing is stored. */
  preview?: boolean;
  chapter: ChapterView & { downloading: boolean };
  pages: PageView[];
}

export interface ChapterTranslatePage {
  pageNumber: number;
  status: 'ok' | 'error' | 'skipped';
}

export interface ChapterTranslateState {
  started?: boolean;
  known?: boolean;
  running: boolean;
  total: number;
  done: number;
  failed: number;
  pages: ChapterTranslatePage[];
  error?: string;
}
/** One speech bubble, positioned in the original page's pixel coordinates. */
export interface OverlayBlock {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Layout box: the bubble interior when one was detected. */
  rx0: number;
  ry0: number;
  rx1: number;
  ry1: number;
  /** Recognized source text, shown on hover. */
  source: string;
  /** What OCR read before stored corrections; the key a new correction uses. */
  reading?: string;
  text: string;
  vertical: boolean;
  inBubble: boolean;
  fill: string;
  color: string;
  fontSize: number;
  lineHeight: number;
  lines: string[];
  /** Mean OCR confidence over the block, 0-100. */
  confidence: number;
  /** The reading is not trustworthy and is marked as such in the reader. */
  uncertain: boolean;
}

export interface PageOverlay {
  v: number;
  width: number;
  height: number;
  sourceLang: string;
  sourceLabel: string;
  targetLang: string;
  engine: string;
  provider: 'claude' | 'deepl' | 'google' | 'none';
  translated: boolean;
  reason?: 'same-language' | 'no-text';
  blocks: OverlayBlock[];
}

export interface TranslateLanguages {
  targets: string[];
  defaultSource: string;
  /** A context-aware LLM provider is configured server-side. */
  llm: boolean;
}
