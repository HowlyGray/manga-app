import Database from 'better-sqlite3';
import path from 'node:path';
import { ensureDirs, dbPath, coverDir, dataDir } from './config';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS titles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'mangadex',
  provider_id TEXT NOT NULL,
  title TEXT NOT NULL,
  alt_titles TEXT,
  original_lang TEXT,
  synopsis TEXT,
  status TEXT,
  year INTEGER,
  author TEXT,
  content_rating TEXT,
  tags TEXT,
  cover_local TEXT,
  jikan_id INTEGER,
  jikan_score REAL,
  jikan_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'mangadex',
  provider_id TEXT NOT NULL,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  chapter_number TEXT,
  chapter_title TEXT,
  volume TEXT,
  language TEXT,
  pages INTEGER,
  external_url TEXT,
  published_at TEXT,
  scanlator TEXT,
  downloaded INTEGER NOT NULL DEFAULT 0,
  download_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chapters_title ON chapters(title_id, chapter_number);

CREATE TABLE IF NOT EXISTS pages (
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  file_name TEXT,
  local_path TEXT,
  size INTEGER,
  downloaded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chapter_id, page_number)
);

CREATE TABLE IF NOT EXISTS reading_progress (
  title_id TEXT PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'scroll',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  title_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  state TEXT,
  PRIMARY KEY (title_id, kind)
);
`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureDirs();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Everything a source told us about a title, kept so browsing the same page
 * twice does not re-fetch it. `kind` separates the title record from its
 * chapter index, which goes stale much faster.
 */
const CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS source_cache (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id, kind)
);
`;

/**
 * Readings the user has fixed by hand, reused on every later page.
 *
 * OCR misreads the same lettering the same way throughout a series, so one
 * correction pays off repeatedly — this is the only form of "training" the app
 * does, and it is the user's own, not a model's.
 */
const CORRECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS corrections (
  source_lang TEXT NOT NULL,
  source_text TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_lang, source_text)
);
`;

/**
 * Word-level fixes learned from bubble corrections. A misread such as `@IÚP`
 * for `GIÚP` recurs inside many different bubbles, which a whole-bubble match
 * never reaches. `origin` is the bubble reading a rule was learned from, so
 * removing that correction removes what it taught.
 */
const CORRECTION_WORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS correction_words (
  source_lang TEXT NOT NULL,
  source_word TEXT NOT NULL,
  corrected_word TEXT NOT NULL,
  origin TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_lang, source_word)
);
`;

/**
 * How far each chapter has been read. Keyed by chapter with no foreign key to
 * the library, so chapters read in preview -- before the title is saved -- are
 * remembered too. `finished` is sticky: scrolling back up a finished chapter
 * does not make it unread. Supersedes `reading_progress`, which kept a single
 * position per title and nothing for titles outside the library; its rows are
 * carried over. Timestamps have millisecond precision because "the chapter
 * being read" is simply the latest row.
 */
const CHAPTER_READS_SCHEMA = `
CREATE TABLE IF NOT EXISTS chapter_reads (
  chapter_id TEXT PRIMARY KEY,
  title_id TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 0,
  pages INTEGER,
  finished INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'scroll',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_chapter_reads_title ON chapter_reads(title_id, updated_at);
INSERT OR IGNORE INTO chapter_reads (chapter_id, title_id, page, mode, updated_at)
  SELECT chapter_id, title_id, page, mode, replace(updated_at, ' ', 'T') || '.000Z' FROM reading_progress;
`;

/**
 * When a title's chapter list was last checked, and when it was last looked
 * at: chapters added after `seen_at` are "new". Existing titles count as seen
 * now, so upgrading does not flag every chapter already there.
 */
const TITLE_UPDATES_SCHEMA = `
ALTER TABLE titles ADD COLUMN seen_at TEXT;
ALTER TABLE titles ADD COLUMN checked_at TEXT;
UPDATE titles SET seen_at = datetime('now');
`;

function migrate(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    db.exec(SCHEMA);
    db.pragma('user_version = 1');
  }
  // A new table in SCHEMA alone would never reach an existing database, since
  // that block only runs once.
  if (version < 2) {
    db.exec(CACHE_SCHEMA);
    db.pragma('user_version = 2');
  }
  if (version < 3) {
    db.exec(CORRECTION_SCHEMA);
    db.pragma('user_version = 3');
  }
  if (version < 4) {
    db.exec(CORRECTION_WORDS_SCHEMA);
    db.pragma('user_version = 4');
  }
  if (version < 5) {
    db.exec(CHAPTER_READS_SCHEMA);
    db.pragma('user_version = 5');
  }
  if (version < 6) {
    db.exec(TITLE_UPDATES_SCHEMA);
    db.pragma('user_version = 6');
  }
}

export { coverDir, dataDir };

export type ChaptersSort = 'asc' | 'desc';

export interface ChapterRow {
  id: string;
  provider_id: string;
  title_id: string;
  chapter_number: string | null;
  chapter_title: string | null;
  volume: string | null;
  language: string | null;
  pages: number | null;
  external_url: string | null;
  published_at: string | null;
  scanlator: string | null;
  downloaded: number;
  download_error: string | null;
  local_path: string | null;
}

/**
 * Makes a library id safe to use as a path segment. Ids from sources other than
 * MangaDex carry a `provider:` prefix, and a colon is not a legal filename
 * character on Windows. MangaDex UUIDs pass through unchanged.
 *
 * Leading dots are replaced as well: `..` survived the character filter, so a
 * request naming `..` as its title and chapter resolved to the app root.
 */
export function pathSegment(id: string): string {
  return id.replace(/[^\w.-]+/g, '_').replace(/^\.+/, (dots) => '_'.repeat(dots.length));
}

/** Resolve the data subdirectory that holds a chapter's downloaded pages. */
export function chapterDir(titleId: string, chapterId: string): string {
  return path.join(dataDir, pathSegment(titleId), pathSegment(chapterId));
}