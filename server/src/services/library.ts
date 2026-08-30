import type Database from 'better-sqlite3';
import path from 'node:path';
import { getDb } from '../db';

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

export interface LibraryTitle extends TitleRecord {
  total_chapters: number;
  downloaded_chapters: number;
  progress_chapter_id: string | null;
  progress_page: number;
}

export interface ChapterRecord {
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
}

export interface ProgressRecord {
  title_id: string;
  chapter_id: string;
  page: number;
  mode: string;
  updated_at: string;
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

export function getTitle(id: string): TitleRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM titles WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTitle(row) : null;
}

export function listLibrary(): LibraryTitle[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.*,
         (SELECT COUNT(*) FROM chapters c WHERE c.title_id = t.id) AS total_chapters,
         (SELECT COUNT(*) FROM chapters c WHERE c.title_id = t.id AND c.downloaded = 1) AS downloaded_chapters,
         p.chapter_id AS progress_chapter_id,
         p.page AS progress_page
       FROM titles t
       LEFT JOIN reading_progress p ON p.title_id = t.id
       ORDER BY t.updated_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => {
    const t = rowToTitle(r);
    return {
      ...t,
      total_chapters: Number(r.total_chapters ?? 0),
      downloaded_chapters: Number(r.downloaded_chapters ?? 0),
      progress_chapter_id: (r.progress_chapter_id as string) ?? null,
      progress_page: Number(r.progress_page ?? 0),
    };
  });
}

export function upsertChapter(ch: {
  id: string;
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
     VALUES (@id, 'mangadex', @provider_id, @title_id, @chapter_number, @chapter_title,
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

/** Distinct chapter languages present for a title, most common first. */
export function listLanguages(titleId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT language, COUNT(*) AS n FROM chapters
       WHERE title_id = ? AND language IS NOT NULL AND language != ''
       GROUP BY language ORDER BY n DESC`,
    )
    .all(titleId) as { language: string; n: number }[];
  return rows.map((r) => r.language);
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

export function replaceChapterPages(
  chapterId: string,
  pageCount: number | null,
  files: string[],
): void {
  const db = getDb();
  db.prepare('DELETE FROM pages WHERE chapter_id = ?').run(chapterId);
  const insert = db.prepare(
    `INSERT INTO pages (chapter_id, page_number, file_name) VALUES (?, ?, ?)`,
  );
  const tx = db.transaction((items: [string, number, string][]) => {
    for (const [cid, num, name] of items) insert.run(cid, num, name);
  });
  tx(
    files.map((f, i) => [chapterId, i + 1, f] as [string, number, string]),
  );
  if (pageCount != null) {
    db.prepare('UPDATE chapters SET pages = ? WHERE id = ?').run(pageCount, chapterId);
  }
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

export function getProgress(titleId: string): ProgressRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM reading_progress WHERE title_id = ?')
    .get(titleId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    title_id: row.title_id as string,
    chapter_id: row.chapter_id as string,
    page: Number(row.page ?? 0),
    mode: (row.mode as string) ?? 'scroll',
    updated_at: row.updated_at as string,
  };
}

export function setProgress(titleId: string, chapterId: string, page: number, mode: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO reading_progress (title_id, chapter_id, page, mode, updated_at)
     VALUES (@title, @chapter, @page, @mode, datetime('now'))
     ON CONFLICT(title_id) DO UPDATE SET
       chapter_id = excluded.chapter_id,
       page = excluded.page,
       mode = excluded.mode,
       updated_at = datetime('now')`,
  ).run({ title: titleId, chapter: chapterId, page, mode });
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