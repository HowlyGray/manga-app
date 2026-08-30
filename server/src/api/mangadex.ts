import { config } from '../config';
import { languageRanker } from '../services/lang';
import { RateLimiter, fetchWithRetry, getJson } from '../util/net';

const BASE = 'https://api.mangadex.org';
const COVER_BASE = 'https://uploads.mangadex.org/covers';

const api = new RateLimiter(config.mangadex.apiIntervalMs);

interface RawRelationship {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

interface RawTag {
  id: string;
  attributes: { name?: { en?: string } };
}

interface RawManga {
  id: string;
  attributes: {
    title?: Record<string, string | undefined>;
    altTitles?: Record<string, string | undefined>[];
    description?: Record<string, string | undefined>;
    originalLanguage?: string | null;
    status?: string | null;
    year?: number | null;
    contentRating?: string | null;
    tags?: RawTag[];
  };
  relationships?: RawRelationship[];
}

interface RawChapter {
  id: string;
  attributes: {
    title?: string | null;
    volume?: string | null;
    chapter?: string | null;
    translatedLanguage?: string;
    pages?: number;
    externalUrl?: string | null;
    publishAt?: string | null;
    readableAt?: string | null;
  };
  relationships?: RawRelationship[];
}

interface MangaListResponse {
  result?: string;
  data?: RawManga[];
  total?: number;
  limit?: number;
  offset?: number;
}

interface ChapterListResponse {
  result?: string;
  data?: RawChapter[];
  total?: number;
  limit?: number;
  offset?: number;
}

export interface MangaDexTitle {
  id: string;
  titles: Record<string, string | undefined>;
  altTitles: string[];
  description: Record<string, string | undefined>;
  originalLanguage: string | null;
  status: string | null;
  year: number | null;
  contentRating: string | null;
  tags: { id: string; name: string }[];
  coverFileName: string | null;
  author: string | null;
  artist: string | null;
}

export interface MangaDexChapter {
  id: string;
  title: string | null;
  volume: string | null;
  chapter: string | null;
  language: string;
  pages: number | null;
  externalUrl: string | null;
  publishAt: string | null;
  scanlator: string | null;
}

export interface AtHomeData {
  baseUrl: string;
  hash: string;
  files: string[];
  dataSaverFiles: string[];
}

export type Language = 'ja' | 'ko' | 'zh' | 'ru' | 'fr' | null;

function localized(obj: Record<string, string | undefined> | undefined): string {
  if (!obj) return '';
  const order = ['en', 'ja-ro', 'ko', 'zh-hk', 'ja', 'en'];
  for (const k of order) {
    const v = obj[k];
    if (v) return v;
  }
  const v = Object.values(obj)[0];
  return v ?? '';
}

function relationship(
  m: { relationships?: RawRelationship[] },
  type: string,
): RawRelationship | undefined {
  return m.relationships?.find((r) => r.type === type);
}

function relName(m: RawManga, type: string): string | null {
  const rel = relationship(m, type);
  const name = (rel?.attributes as { name?: string } | undefined)?.name;
  return name ?? null;
}

function parseManga(raw: RawManga): MangaDexTitle {
  const a = raw.attributes;
  const cover = relationship(raw, 'cover_art');
  const coverFile = (cover?.attributes as { fileName?: string } | undefined)?.fileName ?? null;
  return {
    id: raw.id,
    titles: a.title ?? {},
    altTitles: (a.altTitles ?? []).map((t) => localized(t)).filter(Boolean),
    description: a.description ?? {},
    originalLanguage: a.originalLanguage ?? null,
    status: a.status ?? null,
    year: a.year ?? null,
    contentRating: a.contentRating ?? null,
    tags: (a.tags ?? []).map((t) => ({
      id: t.id,
      name: t.attributes?.name?.en ?? t.id,
    })),
    coverFileName: coverFile,
    author: relName(raw, 'author'),
    artist: relName(raw, 'artist'),
  };
}

function parseChapter(raw: RawChapter): MangaDexChapter {
  const a = raw.attributes;
  const group = relationship(raw, 'scanlation_group');
  const groupName = (group?.attributes as { name?: string } | undefined)?.name ?? null;
  return {
    id: raw.id,
    title: a.title ?? null,
    volume: a.volume ?? null,
    chapter: a.chapter ?? null,
    language: a.translatedLanguage ?? 'en',
    pages: a.pages ?? null,
    externalUrl: a.externalUrl ?? null,
    publishAt: a.publishAt ?? null,
    scanlator: groupName,
  };
}

export function coverThumbUrl(
  mangadexId: string,
  fileName: string | null,
  size: 256 | 512 = 256,
): string | null {
  if (!fileName) return null;
  return `${COVER_BASE}/${mangadexId}/${fileName}.${size}.jpg`;
}

/** Rate-limited, retrying GET of a MangaDex API endpoint. */
function mdGet<T>(url: string): Promise<T | null> {
  return api.run(() =>
    getJson<T>(url, {
      headers: { 'User-Agent': config.mangadex.userAgent },
      retryStatuses: [403, 418],
    }),
  );
}

export interface SearchMangaParams {
  q?: string;
  lang?: string;
  limit?: number;
  offset?: number;
  sort?: 'followedCount' | 'latestUploadedChapter' | 'title';
}

export async function searchManga(
  params: SearchMangaParams = {},
): Promise<{ titles: MangaDexTitle[]; total: number }> {
  const { q, lang, limit = 50, offset = 0, sort = 'followedCount' } = params;
  const query = new URLSearchParams();
  if (q) query.set('title', q);
  if (lang) query.append('originalLanguage[]', lang);
  query.append('hasAvailableChapters', 'true');
  query.append('contentRating[]', 'safe');
  query.append('contentRating[]', 'suggestive');
  query.set('order[followedCount]', 'desc');
  if (sort === 'latestUploadedChapter') query.set('order[latestUploadedChapter]', 'desc');
  if (sort === 'title') query.set('order[title]', 'asc');
  query.set('limit', String(limit));
  query.set('offset', String(offset));
  query.append('includes[]', 'cover_art');
  query.append('includes[]', 'author');
  query.append('includes[]', 'artist');

  const res = await mdGet<MangaListResponse>(`${BASE}/manga?${query.toString()}`);
  return {
    titles: (res?.data ?? []).map(parseManga),
    total: res?.total ?? 0,
  };
}

export async function getManga(id: string): Promise<MangaDexTitle | null> {
  const query = new URLSearchParams();
  query.append('includes[]', 'cover_art');
  query.append('includes[]', 'author');
  query.append('includes[]', 'artist');
  const res = await mdGet<{ data?: RawManga }>(`${BASE}/manga/${id}?${query.toString()}`);
  return res?.data ? parseManga(res.data) : null;
}

export type ChapterSort = 'asc' | 'desc';

/**
 * Returns usable (downloadable) chapters for a manga: no external license
 * redirect and at least one page, one per chapter number.
 *
 * Which translation wins matters more than it looks: after the 2025 takedowns
 * many series only survive in minor languages, and picking the wrong one feeds
 * the translator a scan it can barely read. Solo Leveling was being downloaded
 * in Georgian while a Portuguese release sat next to it.
 */
export async function listChapters(
  mangaId: string,
  opts: { sort?: ChapterSort } = {},
): Promise<MangaDexChapter[]> {
  const sort = opts.sort ?? 'asc';
  const all: MangaDexChapter[] = [];
  let offset = 0;
  const limit = 100;

  for (;;) {
    const query = new URLSearchParams();
    query.set('manga', mangaId);
    query.append('contentRating[]', 'safe');
    query.append('contentRating[]', 'suggestive');
    query.set('order[chapter]', sort);
    query.set('limit', String(limit));
    query.set('offset', String(offset));
    query.append('includes[]', 'scanlation_group');

    const res = await mdGet<ChapterListResponse>(`${BASE}/chapter?${query.toString()}`);
    const batch = res?.data ?? [];
    for (const c of batch) {
      const parsed = parseChapter(c);
      if (!parsed.externalUrl && (parsed.pages ?? 0) > 0) all.push(parsed);
    }
    const total = res?.total ?? 0;
    if (offset + batch.length >= total || batch.length === 0) break;
    offset += batch.length;
  }

  const rank = languageRanker(config.translate.chapterLanguages);
  const seen = new Set<string>();
  const deduped = [...all]
    .sort((a, b) => rank(a.language) - rank(b.language))
    .filter((c) => {
      const key = c.chapter ?? c.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return deduped.sort((a, b) => {
    const na = parseFloat(a.chapter ?? '');
    const nb = parseFloat(b.chapter ?? '');
    const aIsNum = Number.isFinite(na);
    const bIsNum = Number.isFinite(nb);
    if (aIsNum && bIsNum) return na - nb;
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return (a.chapter ?? '').localeCompare(b.chapter ?? '');
  });
}

export async function getAtHomeServer(
  chapterId: string,
): Promise<AtHomeData | null> {
  const res = await mdGet<{
    baseUrl?: string;
    chapter?: { hash?: string; data?: string[]; dataSaver?: string[] };
  }>(`${BASE}/at-home/server/${chapterId}`);
  if (!res?.baseUrl || !res.chapter?.hash) return null;
  return {
    baseUrl: res.baseUrl,
    hash: res.chapter.hash,
    files: res.chapter.data ?? [],
    dataSaverFiles: res.chapter.dataSaver ?? [],
  };
}

export async function downloadImage(url: string): Promise<Response> {
  return fetchWithRetry(url, {
    headers: {
      'User-Agent': config.mangadex.userAgent,
      Accept: 'image/webp,image/*,*/*;q=0.8',
    },
    retries: 4,
  });
}