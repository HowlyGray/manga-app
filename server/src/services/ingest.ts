import fs from 'node:fs';
import path from 'node:path';
import { coverDir, config } from '../config';
import { coverThumbUrl, downloadImage, getManga, listChapters, searchManga, type MangaDexChapter, type MangaDexTitle, type SearchMangaParams } from '../api/mangadex';
import { searchMangaMeta } from '../api/jikan';
import * as lib from './library';
import { downloadChapter } from '../downloader';

const MAIN_KEYS = ['en', 'ja-ro', 'ko', 'ja', 'pt-br', 'es'];

export function mainTitle(t: MangaDexTitle): string {
  for (const k of MAIN_KEYS) {
    const v = t.titles[k];
    if (v) return v;
  }
  const v = Object.values(t.titles)[0];
  return v ?? 'Untitled';
}

export function synopsisEn(t: MangaDexTitle): string {
  return t.description['en'] ?? t.description['ja'] ?? '';
}

export async function discover(
  params: SearchMangaParams,
): Promise<{ total: number; titles: (MangaDexTitle & { coverUrl: string | null })[] }> {
  const { titles, total } = await searchManga(params);
  return {
    total,
    titles: titles.map((t) => ({
      ...t,
      coverUrl: coverThumbUrl(t.id, t.coverFileName, 256),
    })),
  };
}

async function downloadCover(mangadexId: string, fileName: string): Promise<string | null> {
  const url = coverThumbUrl(mangadexId, fileName, 512);
  if (!url) return null;
  const ext = path.extname(fileName) || '.jpg';
  const local = path.join(coverDir, `${mangadexId}${ext}`);
  try {
    await imageFromUrl(url, local);
    return local;
  } catch {
    return null;
  }
}

async function imageFromUrl(url: string, localPath: string): Promise<void> {
  const res = await downloadImage(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, buf);
}

export interface RemoteChapter {
  id: string;
  chapter: string | null;
  title: string | null;
  volume: string | null;
  language: string;
  pages: number | null;
  scanlator: string | null;
  publishedAt: string | null;
}

export interface RemoteTitleDetail {
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
  coverUrl: string | null;
  languages: string[];
  chapters: { total: number; items: RemoteChapter[] };
}

/**
 * Fetches a title's metadata and chapter index directly from MangaDex without
 * touching the local library. Used to browse titles that aren't saved yet.
 */
export async function remoteTitleDetail(mangadexId: string): Promise<RemoteTitleDetail> {
  const t = await getManga(mangadexId);
  if (!t) throw new Error('title not found on MangaDex');

  const chapters = await listChapters(mangadexId, { sort: 'asc' });

  const counts = new Map<string, number>();
  for (const c of chapters) counts.set(c.language, (counts.get(c.language) ?? 0) + 1);
  const languages = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);

  return {
    id: mangadexId,
    title: mainTitle(t),
    altTitles: t.altTitles,
    originalLang: t.originalLanguage,
    synopsis: synopsisEn(t) || null,
    status: t.status,
    year: t.year,
    author: t.author ?? t.artist,
    contentRating: t.contentRating,
    tags: t.tags.map((tg) => tg.name),
    coverUrl: coverThumbUrl(mangadexId, t.coverFileName, 512),
    languages,
    chapters: {
      total: chapters.length,
      items: chapters.map((c) => ({
        id: c.id,
        chapter: c.chapter,
        title: c.title,
        volume: c.volume,
        language: c.language,
        pages: c.pages,
        scanlator: c.scanlator,
        publishedAt: c.publishAt,
      })),
    },
  };
}

export interface ImportResult {
  id: string;
  title: string;
  chaptersImported: number;
  score: number | null;
}

/**
 * Adds a title and its chapter index to the local library. Also downloads the
 * cover locally and enriches metadata via Jikan (best effort).
 */
export async function importTitle(mangadexId: string): Promise<ImportResult> {
  const t = await getManga(mangadexId);
  if (!t) throw new Error(`manga ${mangadexId} not found on MangaDex`);

  const title = mainTitle(t);
  const coverLocal = t.coverFileName ? await downloadCover(mangadexId, t.coverFileName) : null;

  lib.upsertTitle({
    id: mangadexId,
    providerId: mangadexId,
    title,
    altTitles: t.altTitles,
    originalLang: t.originalLanguage,
    synopsis: synopsisEn(t) || null,
    status: t.status,
    year: t.year,
    author: t.author ?? t.artist,
    contentRating: t.contentRating,
    tags: t.tags.map((tg) => tg.name),
    coverLocal,
  });

  const chapters = await listChapters(mangadexId, { sort: 'asc' });
  for (const c of chapters) {
    upsertChapterForTitle(mangadexId, c);
  }

  let score: number | null = null;
  try {
    const meta = await searchMangaMeta(title);
    if (meta) {
      score = meta.score;
      lib.setTitleJikanMetadata(mangadexId, {
        malId: meta.malId,
        score,
        payload: JSON.stringify(meta),
      });
    }
  } catch {
    // enrichment is best-effort
  }

  return { id: mangadexId, title, chaptersImported: chapters.length, score };
}

function upsertChapterForTitle(titleId: string, c: MangaDexChapter): void {
  lib.upsertChapter({
    id: c.id,
    providerId: c.id,
    titleId,
    chapterNumber: c.chapter,
    chapterTitle: c.title,
    volume: c.volume,
    language: c.language,
    pages: c.pages,
    externalUrl: c.externalUrl,
    publishedAt: c.publishAt,
    scanlator: c.scanlator,
  });
}

export interface DownloadTitleResult {
  titleId: string;
  attempted: number;
  downloaded: number;
  failed: number;
  skipped: number;
}

/** Downloads all chapters of a title that aren't already downloaded. */
export async function downloadTitle(
  titleId: string,
  onChapter?: (c: { chapterId: string; downloaded: number; failed: number; index: number; total: number }) => void,
): Promise<DownloadTitleResult> {
  const chapters = lib.listChapters(titleId, 'asc');
  const result: DownloadTitleResult = { titleId, attempted: 0, downloaded: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    if (ch.downloaded === 1) {
      result.skipped++;
      continue;
    }
    result.attempted++;
    try {
      const res = await downloadChapter(titleId, ch.id);
      result.downloaded += res.downloaded;
      result.failed += res.failed;
      onChapter?.({ chapterId: ch.id, downloaded: res.downloaded, failed: res.failed, index: i + 1, total: chapters.length });
    } catch (err) {
      result.failed++;
      onChapter?.({ chapterId: ch.id, downloaded: 0, failed: 1, index: i + 1, total: chapters.length });
      // keep going on a per-chapter failure
      if (err instanceof Error) {
        void err;
      }
    }
  }
  return result;
}

export { config };