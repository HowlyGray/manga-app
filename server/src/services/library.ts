import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { chapterDir, getDb } from '../db';
import { languageRanker } from './lang';

export interface TitleRecord {
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
  jikan_id: number | null;
  jikan_score: number | null;
  created_at: string;
  updated_at: string;
}

/** Counts are of chapter numbers, not of the chapter rows that carry them. */
export interface LibraryTitle extends TitleRecord {
  total_chapters: number;
  /** Chapter numbers with a copy on disk. */
  downloaded_chapters: number;
  /** Chapter numbers with a copy marked finished. */
  read_chapters: number;
  /** Chapter numbers added since the title was last opened. */
  new_chapters: number;
  progress_chapter_id: string | null;
  progress_page: number;
}

/**
 * SQL: the chapter of the story that row `alias` holds. A number can be stored more
 * than once -- in a second language when a better translation turned up after
 * the first was saved, or when a previewed one was downloaded -- and those are
 * one chapter to read. Chapters without a number each stand alone.
 */
const chapterKey = (alias: string) => `COALESCE(NULLIF(${alias}.chapter_number, ''), ${alias}.id)`;

/**
 * SQL condition: chapter `c` of title `t` was added since the title was last
 * opened. Only a chapter number seen for the first time counts -- another
 * translation of a chapter already in the list is not news -- and a chapter
 * already finished (read in preview, say) is not new either.
 */
const IS_NEW = `
  c.created_at > COALESCE(t.seen_at, t.created_at)
  AND NOT EXISTS (
    SELECT 1 FROM chapters o
    WHERE o.title_id = c.title_id AND o.id != c.id
      AND ${chapterKey('o')} = ${chapterKey('c')}
      AND o.created_at <= COALESCE(t.seen_at, t.created_at))
  AND NOT EXISTS (SELECT 1 FROM chapter_reads r WHERE r.chapter_id = c.id AND r.finished = 1)`;

export interface ChapterRecord {
  id: string;
  provider: string;
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
}

export interface ProgressRecord {
  title_id: string;
  chapter_id: string;
  page: number;
  /** Page count of that chapter, when the reader reported it. */
  pages: number | null;
  finished: boolean;
  mode: string;
  updated_at: string;
}

/** How far one chapter has been read. */
export interface ChapterRead {
  page: number;
  pages: number | null;
  finished: boolean;
}

function rowToTitle(row: Record<string, unknown>): TitleRecord {
  return {
    id: row.id as string,
    provider: row.provider as string,
    provider_id: row.provider_id as string,
    title: row.title as string,
    alt_titles: JSON.parse((row.alt_titles as string) ?? '[]'),
    original_lang: (row.original_lang as string) ?? null,
    synopsis: (row.synopsis as string) ?? null,
    status: (row.status as string) ?? null,
    year: (row.year as number | null) ?? null,
    author: (row.author as string) ?? null,
    content_rating: (row.content_rating as string) ?? null,
    tags: JSON.parse((row.tags as string) ?? '[]'),
    cover_local: (row.cover_local as string) ?? null,
    jikan_id: (row.jikan_id as number | null) ?? null,
    jikan_score: (row.jikan_score as number | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToChapter(row: Record<string, unknown>): ChapterRecord {
  return {
    id: row.id as string,
    provider: (row.provider as string) ?? 'mangadex',
    provider_id: row.provider_id as string,
    title_id: row.title_id as string,
    chapter_number: (row.chapter_number as string) ?? null,
    chapter_title: (row.chapter_title as string) ?? null,
    volume: (row.volume as string) ?? null,
    language: (row.language as string) ?? null,
    pages: (row.pages as number | null) ?? null,
    external_url: (row.external_url as string) ?? null,
    published_at: (row.published_at as string) ?? null,
    scanlator: (row.scanlator as string) ?? null,
    downloaded: row.downloaded as number,
    download_error: (row.download_error as string) ?? '',
  };
}

export function upsertTitle(input: {
  id: string;
  provider?: string;
  providerId: string;
  title: string;
  altTitles?: string[];
  originalLang?: string | null;
  synopsis?: string | null;
  status?: string | null;
  year?: number | null;
  author?: string | null;
  contentRating?: string | null;
  tags?: string[];
  coverLocal?: string | null;
}): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM titles WHERE id = ?')
    .get(input.id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE titles SET title = @title, alt_titles = @alt, original_lang = @lang,
       synopsis = @syn, status = @status, year = @year, author = @author,
       content_rating = @rating, tags = @tags, cover_local = @cover, updated_at = datetime('now')
       WHERE id = @id`,
    ).run({
      id: input.id,
      title: input.title,
      alt: JSON.stringify(input.altTitles ?? []),
      lang: input.originalLang ?? null,
      syn: input.synopsis ?? null,
      status: input.status ?? null,
      year: input.year ?? null,
      author: input.author ?? null,
      rating: input.contentRating ?? null,
      tags: JSON.stringify(input.tags ?? []),
      cover: input.coverLocal ?? null,
    });
  } else {
    db.prepare(
      `INSERT INTO titles (id, provider, provider_id, title, alt_titles, original_lang,
       synopsis, status, year, author, content_rating, tags, cover_local)
       VALUES (@id, @provider, @provider_id, @title, @alt, @lang, @syn, @status, @year,
               @author, @rating, @tags, @cover)`,
    ).run({
      id: input.id,
      provider: input.provider ?? 'mangadex',
      provider_id: input.providerId,
      title: input.title,
      alt: JSON.stringify(input.altTitles ?? []),
      lang: input.originalLang ?? null,
      syn: input.synopsis ?? null,
      status: input.status ?? null,
      year: input.year ?? null,
      author: input.author ?? null,
      rating: input.contentRating ?? null,
      tags: JSON.stringify(input.tags ?? []),
      cover: input.coverLocal ?? null,
    });
  }
}

export function setTitleJikanMetadata(
  id: string,
  meta: { malId: number; score: number | null; payload: string } | null,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE titles SET jikan_id = @malId, jikan_score = @score, jikan_payload = @payload,
     updated_at = datetime('now') WHERE id = @id`,
  ).run({ id, malId: meta?.malId ?? null, score: meta?.score ?? null, payload: meta?.payload ?? null });
}

/** What a source says about a title, as far as a refresh may change it. */
export interface TitleDetails {
  title: string;
  altTitles: string[];
  originalLang: string | null;
  synopsis: string | null;
  status: string | null;
  year: number | null;
  author: string | null;
  contentRating: string | null;
  tags: string[];
}

/**
 * Applies fresh details from a source and says whether anything changed.
 *
 * A detail the source leaves empty keeps its stored value: a page that only
 * half parsed, or a source that hides a field for a moment, must not blank out
 * a synopsis the library already has. The cover is not touched here, and
 * `updated_at` moves only on a real change.
 */
export function updateTitleDetails(id: string, details: TitleDetails): boolean {
  const current = getTitle(id);
  if (!current) return false;
  const next = {
    title: details.title.trim() || current.title,
    altTitles: details.altTitles.length > 0 ? details.altTitles : current.alt_titles,
    originalLang: details.originalLang ?? current.original_lang,
    synopsis: details.synopsis || current.synopsis,
    status: details.status ?? current.status,
    year: details.year ?? current.year,
    author: details.author ?? current.author,
    contentRating: details.contentRating ?? current.content_rating,
    tags: details.tags.length > 0 ? details.tags : current.tags,
  };
  const shape = (d: Record<string, unknown>) => JSON.stringify(Object.values(d));
  const before = shape({
    title: current.title,
    altTitles: current.alt_titles,
    originalLang: current.original_lang,
    synopsis: current.synopsis,
    status: current.status,
    year: current.year,
    author: current.author,
    contentRating: current.content_rating,
    tags: current.tags,
  });
  if (shape(next) === before) return false;

  getDb()
    .prepare(
      `UPDATE titles SET title = @title, alt_titles = @alt, original_lang = @lang, synopsis = @syn,
       status = @status, year = @year, author = @author, content_rating = @rating, tags = @tags,
       updated_at = datetime('now') WHERE id = @id`,
    )
    .run({
      id,
      title: next.title,
      alt: JSON.stringify(next.altTitles),
      lang: next.originalLang,
      syn: next.synopsis,
      status: next.status,
      year: next.year,
      author: next.author,
      rating: next.contentRating,
      tags: JSON.stringify(next.tags),
    });
  return true;
}

export function getTitle(id: string): TitleRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM titles WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTitle(row) : null;
}

/**
 * Newest addition first, as the "Recently added" sort says. It used to order by
 * `updated_at`, which every sync moves: refreshing a title carried it to the top.
 */
export function listLibrary(): LibraryTitle[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.*,
         (SELECT COUNT(DISTINCT ${chapterKey('c')}) FROM chapters c WHERE c.title_id = t.id) AS total_chapters,
         (SELECT COUNT(DISTINCT ${chapterKey('c')}) FROM chapters c
            WHERE c.title_id = t.id AND c.downloaded = 1) AS downloaded_chapters,
         (SELECT COUNT(DISTINCT ${chapterKey('c')}) FROM chapters c JOIN chapter_reads r ON r.chapter_id = c.id
            WHERE c.title_id = t.id AND r.finished = 1) AS read_chapters,
         (SELECT COUNT(DISTINCT ${chapterKey('c')}) FROM chapters c
            WHERE c.title_id = t.id AND ${IS_NEW}) AS new_chapters,
         p.chapter_id AS progress_chapter_id,
         p.page AS progress_page
       FROM titles t
       LEFT JOIN chapter_reads p ON p.chapter_id = (
         SELECT r.chapter_id FROM chapter_reads r WHERE r.title_id = t.id
         ORDER BY r.updated_at DESC LIMIT 1)
       ORDER BY t.created_at DESC, t.rowid DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => {
    const t = rowToTitle(r);
    return {
      ...t,
      total_chapters: Number(r.total_chapters ?? 0),
      downloaded_chapters: Number(r.downloaded_chapters ?? 0),
      read_chapters: Number(r.read_chapters ?? 0),
      new_chapters: Number(r.new_chapters ?? 0),
      progress_chapter_id: (r.progress_chapter_id as string) ?? null,
      progress_page: Number(r.progress_page ?? 0),
    };
  });
}

export function upsertChapter(ch: {
  id: string;
  provider?: string;
  providerId: string;
  titleId: string;
  chapterNumber: string | null;
  chapterTitle: string | null;
  volume: string | null;
  language: string;
  pages: number | null;
  externalUrl: string | null;
  publishedAt: string | null;
  scanlator: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO chapters (id, provider, provider_id, title_id, chapter_number, chapter_title,
     volume, language, pages, external_url, published_at, scanlator)
     VALUES (@id, @provider, @provider_id, @title_id, @chapter_number, @chapter_title,
             @volume, @language, @pages, @external_url, @published_at, @scanlator)
     ON CONFLICT(id) DO UPDATE SET
       chapter_number = excluded.chapter_number,
       chapter_title = excluded.chapter_title,
       volume = excluded.volume,
       language = excluded.language,
       pages = excluded.pages,
       external_url = excluded.external_url,
       published_at = excluded.published_at,
       scanlator = excluded.scanlator,
       updated_at = datetime('now')`,
  ).run({
    id: ch.id,
    provider: ch.provider ?? 'mangadex',
    provider_id: ch.providerId,
    title_id: ch.titleId,
    chapter_number: ch.chapterNumber,
    chapter_title: ch.chapterTitle,
    volume: ch.volume,
    language: ch.language,
    pages: ch.pages,
    external_url: ch.externalUrl,
    published_at: ch.publishedAt,
    scanlator: ch.scanlator,
  });
}

export function listChapters(titleId: string, sort: 'asc' | 'desc' = 'asc'): ChapterRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM chapters WHERE title_id = ? ORDER BY
         CASE WHEN chapter_number IS NULL OR chapter_number = '' THEN 1 ELSE 0 END,
         CAST(chapter_number AS REAL) ${sort === 'desc' ? 'DESC' : 'ASC'}`,
    )
    .all(titleId) as Record<string, unknown>[];
  return rows.map(rowToChapter);
}

/** Distinct chapter languages for a title, the ones we read best listed first. */
export function listLanguages(titleId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT language, COUNT(*) AS n FROM chapters
       WHERE title_id = ? AND language IS NOT NULL AND language != ''
       GROUP BY language ORDER BY n DESC`,
    )
    .all(titleId) as { language: string; n: number }[];
  const rank = languageRanker(config.translate.chapterLanguages);
  return rows
    .sort((a, b) => rank(a.language) - rank(b.language) || b.n - a.n)
    .map((r) => r.language);
}

/** Optional language filter for a title's chapter list. */
export function listChaptersByLanguage(
  titleId: string,
  language?: string,
  sort: 'asc' | 'desc' = 'asc',
): ChapterRecord[] {
  const all = listChapters(titleId, sort);
  if (!language) return all;
  return all.filter((c) => c.language === language);
}

export function getChapter(titleId: string, chapterId: string): ChapterRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM chapters WHERE title_id = ? AND id = ?')
    .get(titleId, chapterId) as Record<string, unknown> | undefined;
  return row ? rowToChapter(row) : null;
}

export function setChapterDownloaded(
  chapterId: string,
  downloaded: number,
  error?: string | null,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE chapters SET downloaded = @downloaded, download_error = @error,
     updated_at = datetime('now') WHERE id = @id`,
  ).run({ id: chapterId, downloaded, error: error ?? null });
}

/**
 * Records the page list for a chapter, keeping whatever is already downloaded.
 *
 * This used to DELETE every row and re-insert, which threw away `local_path`
 * for files still sitting on disk. Re-running a download then had a window
 * where the library pointed at nothing until each page was re-marked, and a
 * crash or restart inside it left the chapter permanently unreadable with all
 * of its images present.
 */
export function replaceChapterPages(
  chapterId: string,
  pageCount: number | null,
  files: string[],
): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO pages (chapter_id, page_number, file_name) VALUES (?, ?, ?)
     ON CONFLICT(chapter_id, page_number) DO UPDATE SET file_name = excluded.file_name`,
  );
  const trim = db.prepare('DELETE FROM pages WHERE chapter_id = ? AND page_number > ?');
  const tx = db.transaction((names: string[]) => {
    names.forEach((name, i) => upsert.run(chapterId, i + 1, name));
    // Only pages that no longer exist upstream are removed.
    trim.run(chapterId, names.length);
  });
  tx(files);
  if (pageCount != null) {
    db.prepare('UPDATE chapters SET pages = ? WHERE id = ?').run(pageCount, chapterId);
  }
}

/**
 * On-disk file for a page, repairing the row when the database lost track of a
 * file that is still there. Pages are written as `0001.png`, `0002.jpg`, … so
 * the name can be recovered from the page number alone.
 */
export function pageFile(titleId: string, chapterId: string, pageNumber: number): string | null {
  const known = listPages(chapterId).find((p) => p.page_number === pageNumber)?.local_path;
  if (known && fs.existsSync(known)) return known;

  const dir = chapterDir(titleId, chapterId);
  const prefix = String(pageNumber).padStart(4, '0');
  let match: string | undefined;
  try {
    match = fs.readdirSync(dir).find((f) => f.startsWith(`${prefix}.`));
  } catch {
    return null;
  }
  if (!match) return null;

  const local = path.join(dir, match);
  markPageDownloaded(chapterId, pageNumber, local, null);
  return local;
}

export function markPageDownloaded(chapterId: string, pageNumber: number, localPath: string, size: number | null): void {
  const db = getDb();
  db.prepare(
    `UPDATE pages SET downloaded = 1, local_path = ?, size = ? WHERE chapter_id = ? AND page_number = ?`,
  ).run(localPath, size, chapterId, pageNumber);
}

export interface PageRecord {
  page_number: number;
  file_name: string | null;
  local_path: string | null;
  size: number | null;
  downloaded: number;
}

export function listPages(chapterId: string): PageRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM pages WHERE chapter_id = ? ORDER BY page_number')
    .all(chapterId) as Record<string, unknown>[];
  return rows.map((r) => ({
    page_number: Number(r.page_number),
    file_name: (r.file_name as string) ?? null,
    local_path: (r.local_path as string) ?? null,
    size: (r.size as number | null) ?? null,
    downloaded: Number(r.downloaded ?? 0),
  }));
}

/** Millisecond-precision UTC timestamp, the format `chapter_reads` sorts by. */
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Where reading left off in a title: the most recently read chapter. Works for
 * titles outside the library too, since reads are kept per chapter.
 */
export function getProgress(titleId: string): ProgressRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM chapter_reads WHERE title_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(titleId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    title_id: row.title_id as string,
    chapter_id: row.chapter_id as string,
    page: Number(row.page ?? 0),
    pages: (row.pages as number | null) ?? null,
    finished: Number(row.finished) === 1,
    mode: (row.mode as string) ?? 'scroll',
    updated_at: row.updated_at as string,
  };
}

/**
 * Records the page being read. Reaching the last page marks the chapter
 * finished, and finished stays set when the reader scrolls back up.
 */
export function setProgress(
  titleId: string,
  chapterId: string,
  page: number,
  mode: string,
  pages: number | null = null,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO chapter_reads (chapter_id, title_id, page, pages, finished, mode, updated_at)
     VALUES (@chapter, @title, @page, @pages, @finished, @mode, ${NOW})
     ON CONFLICT(chapter_id) DO UPDATE SET
       title_id = excluded.title_id,
       page = excluded.page,
       pages = COALESCE(excluded.pages, chapter_reads.pages),
       finished = MAX(chapter_reads.finished, excluded.finished),
       mode = excluded.mode,
       updated_at = excluded.updated_at`,
  ).run({
    title: titleId,
    chapter: chapterId,
    page,
    pages,
    finished: pages != null && page >= pages ? 1 : 0,
    mode,
  });
}

/** Marks a chapter read or unread by hand, from the chapter list. */
export function setChapterFinished(titleId: string, chapterId: string, finished: boolean): void {
  const db = getDb();
  if (finished) {
    // Also makes it the latest read, so "continue" moves on past it.
    db.prepare(
      `INSERT INTO chapter_reads (chapter_id, title_id, finished, updated_at)
       VALUES (?, ?, 1, ${NOW})
       ON CONFLICT(chapter_id) DO UPDATE SET finished = 1, updated_at = excluded.updated_at`,
    ).run(chapterId, titleId);
  } else {
    db.prepare('UPDATE chapter_reads SET finished = 0, page = 0 WHERE chapter_id = ?').run(chapterId);
  }
}

/**
 * Deletes a title and everything recorded about it. Chapters, pages and the old
 * progress rows go with it through their foreign keys; reads are not tied to
 * the library, so they are removed explicitly.
 */
export function deleteTitle(titleId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM chapter_reads WHERE title_id = ?').run(titleId);
    db.prepare('DELETE FROM titles WHERE id = ?').run(titleId);
  })();
}

/** A chapter's files are gone: forget its pages, and offer it for download again. */
export function forgetChapterFiles(chapterId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM pages WHERE chapter_id = ?').run(chapterId);
    db.prepare(
      `UPDATE chapters SET downloaded = 0, download_error = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(chapterId);
  })();
}

/** Ids of the chapters added to a title since it was last opened. */
export function newChapterIds(titleId: string): Set<string> {
  const rows = getDb()
    .prepare(`SELECT c.id FROM chapters c JOIN titles t ON t.id = c.title_id WHERE t.id = ? AND ${IS_NEW}`)
    .all(titleId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** New chapter numbers of a title, counted the way the library badge counts them. */
export function countNewChapters(titleId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT ${chapterKey('c')}) AS n FROM chapters c JOIN titles t ON t.id = c.title_id
       WHERE t.id = ? AND ${IS_NEW}`,
    )
    .get(titleId) as { n: number };
  return row.n;
}

/** The title has been looked at: its chapters stop being new. */
export function markSeen(titleId: string): void {
  getDb().prepare(`UPDATE titles SET seen_at = datetime('now') WHERE id = ?`).run(titleId);
}

/** SQLite keeps `datetime('now')` as `YYYY-MM-DD HH:MM:SS`, in UTC and with no zone marker. */
const sqlTime = (date: Date): string => date.toISOString().slice(0, 19).replace('T', ' ');

export function parseSqlTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * Its chapter list was just fetched again. `at` is when that fetch began, not
 * when it ended: the next incremental check looks back from there, and a
 * chapter uploaded while a long listing ran must not fall between the two.
 */
export function markChecked(titleId: string, at: Date = new Date()): void {
  getDb().prepare('UPDATE titles SET checked_at = ? WHERE id = ?').run(sqlTime(at), titleId);
}

/** When the title's chapter list was last fetched, or null if it never was. */
export function getChecked(titleId: string): Date | null {
  const row = getDb().prepare('SELECT checked_at FROM titles WHERE id = ?').get(titleId) as
    | { checked_at: string | null }
    | undefined;
  return parseSqlTime(row?.checked_at);
}

export interface TitleToCheck {
  id: string;
  title: string;
  provider: string;
}

/**
 * Saved titles whose chapter list was last fetched longer ago than
 * `olderThanMs`, or never; every title when no age is given. The longest
 * neglected come first, so a run cut short leaves the freshest for next time.
 */
export function titlesToCheck(olderThanMs?: number): TitleToCheck[] {
  const rows = getDb().prepare('SELECT id, title, provider, checked_at FROM titles').all() as (TitleToCheck & {
    checked_at: string | null;
  })[];
  const cutoff = olderThanMs == null ? Infinity : Date.now() - olderThanMs;
  return rows
    .map((r) => ({ id: r.id, title: r.title, provider: r.provider, at: parseSqlTime(r.checked_at)?.getTime() ?? 0 }))
    .filter((r) => r.at < cutoff)
    .sort((a, b) => a.at - b.at)
    .map(({ id, title, provider }) => ({ id, title, provider }));
}

/** Languages a title's chapters are stored in, the one covering the most chapter numbers first. */
export function languagesByUse(titleId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT c.language AS language, COUNT(DISTINCT ${chapterKey('c')}) AS n FROM chapters c
       WHERE c.title_id = ? AND c.language IS NOT NULL AND c.language != ''
       GROUP BY c.language ORDER BY n DESC, c.language`,
    )
    .all(titleId) as { language: string; n: number }[];
  return rows.map((r) => r.language);
}

/** What a title already holds: every chapter id, and the languages stored under each chapter number. */
export function chapterIndex(titleId: string): { ids: Set<string>; languages: Map<string, string[]> } {
  const rows = getDb()
    .prepare('SELECT id, chapter_number, language FROM chapters WHERE title_id = ?')
    .all(titleId) as { id: string; chapter_number: string | null; language: string | null }[];
  const ids = new Set<string>();
  const languages = new Map<string, string[]>();
  for (const row of rows) {
    ids.add(row.id);
    if (!row.chapter_number) continue;
    const held = languages.get(row.chapter_number) ?? [];
    held.push(row.language ?? '');
    languages.set(row.chapter_number, held);
  }
  return { ids, languages };
}

/** Runs `fn` as one transaction: hundreds of chapter rows cost one disk sync instead of one each. */
export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

/** Read state of every chapter of a title that has been opened, by chapter id. */
export function readsFor(titleId: string): Map<string, ChapterRead> {
  const rows = getDb()
    .prepare('SELECT chapter_id, page, pages, finished FROM chapter_reads WHERE title_id = ?')
    .all(titleId) as { chapter_id: string; page: number; pages: number | null; finished: number }[];
  return new Map(
    rows.map((r) => [r.chapter_id, { page: r.page, pages: r.pages, finished: r.finished === 1 }]),
  );
}

export function clearLibrary(): void {
  const db = getDb();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM titles').run();
}

export function serveDataPath(relPath: string | null): string | null {
  if (!relPath) return null;
  return path.resolve(relPath);
}

export function toDataUrl(titleId: string, chapterId: string, pageNumber: number): string {
  return `/api/library/data/${titleId}/${chapterId}/${pageNumber}`;
}

// Re-export so callers sharing a connection type have a simple import surface.
export type { Database };