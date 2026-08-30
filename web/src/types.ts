export interface DiscoverItem {
  id: string;
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
  total: number;
  page: number;
  limit: number;
  titles: DiscoverItem[];
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