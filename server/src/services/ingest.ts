import fs from 'node:fs';
import path from 'node:path';
import { coverDir, config } from '../config';
import { searchMangaMeta } from '../api/jikan';
import * as lib from './library';
import { downloadChapter } from '../downloader';
import { languageRanker } from './lang';
import {
  decodeId,
  encodeId,
  getProvider,
  type SourceChapter,
  type SourceProvider,
  type SourceSearch,
  type SourceTitle,
} from '../sources';

export { mainTitle, synopsisEn } from '../sources';

export interface DiscoverParams extends SourceSearch {
  /** Provider key; defaults to MangaDex. */
  source?: string;
}

export async function discover(
  params: DiscoverParams,
): Promise<{ total: number; source: string; titles: (SourceTitle & { libraryId: string })[] }> {
  const provider = getProvider(params.source);
  const { titles, total } = await provider.search(params);
  return {
    total,
    source: provider.id,
    titles: titles.map((t) => ({ ...t, libraryId: encodeId(provider.id, t.id) })),
  };
}

async function downloadCover(libraryId: string, url: string): Promise<string | null> {
  if (!url) return null;
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  // Library ids may carry a `provider:` prefix, which is not a legal filename.
  const local = path.join(coverDir, `${libraryId.replace(/[^\w.-]+/g, '_')}${ext}`);
  try {
    const res = await getProvider(decodeId(libraryId).provider).fetchImage({ url });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, buf);
    return local;
  } catch {
    return null;
  }
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
  source: string;
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

/** Chapter languages present, ordered by how well the OCR chain reads them. */
function languagesOf(chapters: SourceChapter[]): string[] {
  const counts = new Map<string, number>();
  for (const c of chapters) counts.set(c.language, (counts.get(c.language) ?? 0) + 1);
  const rank = languageRanker(config.translate.chapterLanguages);
  return [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
    .map(([language]) => language);
}

/**
 * Fetches a title's metadata and chapter index straight from its source,
 * without touching the local library. Used to browse titles not saved yet.
 */
export async function remoteTitleDetail(libraryId: string): Promise<RemoteTitleDetail> {
  const { provider: source, providerId } = decodeId(libraryId);
  const provider = getProvider(source);

  const t = await provider.getTitle(providerId);
  if (!t) throw new Error(`title not found on ${provider.label}`);
  const chapters = await provider.listChapters(providerId);

  return {
    id: libraryId,
    source: provider.id,
    title: t.title,
    altTitles: t.altTitles,
    originalLang: t.originalLang,
    synopsis: t.synopsis,
    status: t.status,
    year: t.year,
    author: t.author,
    contentRating: t.contentRating,
    tags: t.tags,
    coverUrl: t.coverUrl,
    languages: languagesOf(chapters),
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
        publishedAt: c.publishedAt,
      })),
    },
  };
}

export interface ImportResult {
  id: string;
  source: string;
  title: string;
  chaptersImported: number;
  score: number | null;
}

/**
 * Adds a title and its chapter index to the local library. Also downloads the
 * cover locally and enriches metadata via Jikan (best effort).
 */
export async function importTitle(libraryId: string): Promise<ImportResult> {
  const { provider: source, providerId } = decodeId(libraryId);
  const provider = getProvider(source);

  const t = await provider.getTitle(providerId);
  if (!t) throw new Error(`${providerId} not found on ${provider.label}`);

  const id = encodeId(provider.id, providerId);
  const coverLocal = t.coverUrl ? await downloadCover(id, t.coverUrl) : null;

  lib.upsertTitle({
    id,
    provider: provider.id,
    providerId,
    title: t.title,
    altTitles: t.altTitles,
    originalLang: t.originalLang,
    synopsis: t.synopsis,
    status: t.status,
    year: t.year,
    author: t.author,
    contentRating: t.contentRating,
    tags: t.tags,
    coverLocal,
  });

  const chapters = await provider.listChapters(providerId);
  for (const c of chapters) upsertChapterForTitle(provider, id, c);

  let score: number | null = null;
  try {
    const meta = await searchMangaMeta(t.title);
    if (meta) {
      score = meta.score;
      lib.setTitleJikanMetadata(id, { malId: meta.malId, score, payload: JSON.stringify(meta) });
    }
  } catch {
    // enrichment is best-effort
  }

  return { id, source: provider.id, title: t.title, chaptersImported: chapters.length, score };
}

function upsertChapterForTitle(provider: SourceProvider, titleId: string, c: SourceChapter): void {
  lib.upsertChapter({
    id: encodeId(provider.id, c.id),
    provider: provider.id,
    providerId: c.id,
    titleId,
    chapterNumber: c.chapter,
    chapterTitle: c.title,
    volume: c.volume,
    language: c.language,
    pages: c.pages,
    externalUrl: c.externalUrl,
    publishedAt: c.publishedAt,
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

/**
 * Picks one chapter per chapter number.
 *
 * A title can carry the same chapter in several languages. What is already on
 * disk wins, so re-running a download never duplicates the library; otherwise
 * the language the OCR chain reads best wins.
 */
function pickOnePerChapter(chapters: lib.ChapterRecord[]): lib.ChapterRecord[] {
  const rank = languageRanker(config.translate.chapterLanguages);
  const best = new Map<string, lib.ChapterRecord>();
  for (const ch of chapters) {
    const key = ch.chapter_number ?? ch.id;
    const current = best.get(key);
    if (!current) {
      best.set(key, ch);
      continue;
    }
    const currentHave = current.downloaded === 1;
    const candidateHave = ch.downloaded === 1;
    if (candidateHave !== currentHave) {
      if (candidateHave) best.set(key, ch);
    } else if (rank(ch.language) < rank(current.language)) {
      best.set(key, ch);
    }
  }
  const keep = new Set(best.values());
  return chapters.filter((c) => keep.has(c));
}

/** Downloads all chapters of a title that aren't already downloaded. */
export async function downloadTitle(
  titleId: string,
  onChapter?: (c: { chapterId: string; downloaded: number; failed: number; index: number; total: number }) => void,
): Promise<DownloadTitleResult> {
  const chapters = pickOnePerChapter(lib.listChapters(titleId, 'asc'));
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
