/**
 * Persistent cache for everything a source tells us about a title.
 *
 * Browsing used to cost the same traffic every time: search results pointed
 * straight at the upstream cover CDN, and opening a title that is not in the
 * library re-fetched its description, tags and chapter index on every visit.
 * Metadata is stored in SQLite with a TTL, covers on disk without one — a cover
 * for a given title is effectively immutable, so it is kept until deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { coverCacheDir, config } from '../config';
import { getDb, pathSegment } from '../db';
import { decodeId, getProvider, type SourceChapter, type SourceTitle } from '../sources';
import { getTitle } from './library';

type Kind = 'title' | 'chapters' | 'pages';

interface CacheRow {
  payload: string;
  fetched_at: string;
}

function read<T>(id: string, kind: Kind, maxAgeMs: number): T | null {
  if (maxAgeMs <= 0) return null;
  const row = getDb()
    .prepare('SELECT payload, fetched_at FROM source_cache WHERE id = ? AND kind = ?')
    .get(id, kind) as CacheRow | undefined;
  if (!row) return null;

  // SQLite's datetime('now') is UTC without a zone marker; say so explicitly or
  // Date parses it as local time and every entry looks hours out of date.
  const fetchedAt = Date.parse(`${row.fetched_at.replace(' ', 'T')}Z`);
  if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > maxAgeMs) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

function write(id: string, kind: Kind, payload: unknown): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO source_cache (id, kind, payload, fetched_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(id, kind) DO UPDATE SET
           payload = excluded.payload,
           fetched_at = excluded.fetched_at`,
      )
      .run(id, kind, JSON.stringify(payload));
  } catch {
    // The cache is an optimisation; a write failure must not break a request.
  }
}

/** Records a title so its cover URL and metadata survive the request. */
export function rememberTitle(libraryId: string, title: SourceTitle): void {
  write(libraryId, 'title', title);
}

export function cachedTitle(libraryId: string, maxAgeMs = config.cache.titleMs): SourceTitle | null {
  return read<SourceTitle>(libraryId, 'title', maxAgeMs);
}

export function rememberChapters(libraryId: string, chapters: SourceChapter[]): void {
  write(libraryId, 'chapters', chapters);
}

export function cachedChapters(
  libraryId: string,
  maxAgeMs = config.cache.chaptersMs,
): SourceChapter[] | null {
  return read<SourceChapter[]>(libraryId, 'chapters', maxAgeMs);
}

/** Page image URLs of a chapter, so paging a preview does not re-ask upstream. */
export function rememberPages(chapterLibraryId: string, pages: unknown[]): void {
  write(chapterLibraryId, 'pages', pages);
}

export function cachedPages<T>(chapterLibraryId: string, maxAgeMs: number): T[] | null {
  return read<T[]>(chapterLibraryId, 'pages', maxAgeMs);
}

/** Drops a title's cached metadata, so the next read goes upstream. */
export function forgetTitle(libraryId: string): void {
  try {
    getDb().prepare('DELETE FROM source_cache WHERE id = ?').run(libraryId);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------

/** Existing cover file for a library id, whatever extension it was saved with. */
function existingCover(libraryId: string): string | null {
  const base = pathSegment(libraryId);
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
    const file = path.join(coverCacheDir, base + ext);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

let active = 0;
const waiting: (() => void)[] = [];

/** Caps parallel cover downloads so one grid does not open 30 connections. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.cache.coverConcurrency) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Downloads in flight, so a grid of duplicates fetches each cover once. */
const inFlight = new Map<string, Promise<string | null>>();

async function download(libraryId: string, url: string): Promise<string | null> {
  const ext = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
  const file = path.join(coverCacheDir, pathSegment(libraryId) + ext);
  try {
    const res = await withSlot(() => getProvider(decodeId(libraryId).provider).fetchImage({ url }));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write then rename: a request that arrives mid-download must not read a
    // half-written file and cache a broken image.
    const temp = `${file}.part`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, file);
    return file;
  } catch (err) {
    console.warn(
      `[cover] ${libraryId} failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Local path of a title's cover, downloading it once if needed.
 *
 * Library titles keep the copy the import made; everything else lands in the
 * cover cache the first time it is displayed.
 */
export function coverFile(libraryId: string): Promise<string | null> {
  const saved = getTitle(libraryId)?.cover_local;
  if (saved && fs.existsSync(saved)) return Promise.resolve(saved);

  const cached = existingCover(libraryId);
  if (cached) return Promise.resolve(cached);

  const running = inFlight.get(libraryId);
  if (running) return running;

  const url = cachedTitle(libraryId, Number.POSITIVE_INFINITY)?.coverUrl;
  if (!url) return Promise.resolve(null);

  const task = download(libraryId, url).finally(() => inFlight.delete(libraryId));
  inFlight.set(libraryId, task);
  return task;
}
