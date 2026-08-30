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
  total_chapters: number;
  downloaded_chapters: number;
  progress_chapter_id: string | null;
  progress_page: number;
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
}

export interface Progress {
  title_id: string;
  chapter_id: string | null;
  page: number;
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
  text: string;
  vertical: boolean;
  inBubble: boolean;
  fill: string;
  color: string;
  fontSize: number;
  lineHeight: number;
  lines: string[];
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
