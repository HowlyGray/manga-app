/** MangaDex as a `SourceProvider`; the HTTP client itself lives in api/mangadex. */
import { config } from '../config';
import {
  coverThumbUrl,
  downloadImage,
  getAtHomeServer,
  getManga,
  listChapters,
  listTags,
  searchManga,
  type MangaDexTitle,
  type MangaSort,
} from '../api/mangadex';
import type {
  PageImage,
  SearchSort,
  SourceChapter,
  SourceProvider,
  SourceSearch,
  SourceShelf,
  SourceTag,
  SourceTitle,
} from './types';

const MAIN_KEYS = ['en', 'ja-ro', 'ko', 'ja', 'pt-br', 'es'];

/** Picks the most useful of a title's localized names. */
export function mainTitle(t: MangaDexTitle): string {
  for (const k of MAIN_KEYS) {
    const hit = t.titles[k];
    if (hit) return hit;
  }
  return Object.values(t.titles).find(Boolean) ?? t.altTitles[0] ?? 'Untitled';
}

export function synopsisEn(t: MangaDexTitle): string {
  return t.description.en ?? Object.values(t.description).find(Boolean) ?? '';
}

function toSourceTitle(t: MangaDexTitle, coverSize: 256 | 512): SourceTitle {
  return {
    id: t.id,
    title: mainTitle(t),
    altTitles: t.altTitles,
    originalLang: t.originalLanguage,
    synopsis: synopsisEn(t) || null,
    status: t.status,
    year: t.year,
    author: t.author ?? t.artist,
    contentRating: t.contentRating,
    tags: t.tags.map((tag) => tag.name),
    coverUrl: coverThumbUrl(t.id, t.coverFileName, coverSize),
  };
}

const SORTS: Record<SearchSort, MangaSort> = {
  popular: 'followedCount',
  latest: 'latestUploadedChapter',
  newest: 'createdAt',
  rating: 'rating',
  relevance: 'relevance',
  title: 'title',
};

/** ISO timestamp `days` ago, in the shape MangaDex wants (no zone suffix). */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19);
}

/** The tag list is effectively static; fetch it once per process. */
let tagCache: Promise<SourceTag[]> | null = null;

/**
 * Home shelves cost four searches, so they are cached briefly. The point of the
 * page is what is moving right now, not up-to-the-second accuracy.
 */
let shelfCache: { at: number; shelves: Promise<SourceShelf[]> } | null = null;
const SHELF_TTL_MS = 10 * 60 * 1000;

async function buildShelves(): Promise<SourceShelf[]> {
  const specs: { id: string; title: string; subtitle: string; search: SourceSearch }[] = [
    {
      id: 'trending',
      title: 'Trending now',
      subtitle: 'Most followed on MangaDex',
      search: { sort: 'popular', limit: 18 },
    },
    {
      id: 'latest',
      title: 'Fresh chapters',
      subtitle: 'Updated most recently',
      search: { sort: 'latest', limit: 18 },
    },
    {
      id: 'rising',
      title: 'New and rising',
      subtitle: 'Added in the last 30 days, by follower count',
      search: { sort: 'popular', createdSince: daysAgo(30), limit: 18 },
    },
    {
      id: 'rated',
      title: 'Top rated',
      subtitle: 'Highest reader rating',
      search: { sort: 'rating', limit: 18 },
    },
  ];

  const shelves: SourceShelf[] = [];
  for (const spec of specs) {
    try {
      const { titles } = await mangadexProvider.search(spec.search);
      if (titles.length > 0) {
        shelves.push({
          id: spec.id,
          title: spec.title,
          subtitle: spec.subtitle,
          titles,
          browse: { sort: spec.search.sort, createdSince: spec.search.createdSince },
        });
      }
    } catch (err) {
      // One failing row should not empty the home page.
      console.error(`[home] shelf ${spec.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return shelves;
}

export const mangadexProvider: SourceProvider = {
  id: 'mangadex',
  label: 'MangaDex',
  browsable: true,
  // `Collections offset query param may not be >10000`.
  maxOffset: 10000,

  async search(params: SourceSearch) {
    const { titles, total } = await searchManga({
      q: params.q,
      lang: params.lang as never,
      limit: params.limit,
      offset: params.offset,
      includedTags: params.tags,
      createdSince: params.createdSince,
      // A search term with no explicit order should rank by relevance.
      sort: SORTS[params.sort ?? (params.q ? 'relevance' : 'popular')],
    });
    return { total, titles: titles.map((t) => toSourceTitle(t, 256)) };
  },

  listTags() {
    tagCache ??= listTags().catch((err) => {
      tagCache = null;
      throw err;
    });
    return tagCache;
  },

  homeShelves() {
    if (!shelfCache || Date.now() - shelfCache.at > SHELF_TTL_MS) {
      const shelves = buildShelves();
      shelfCache = { at: Date.now(), shelves };
      shelves.catch(() => {
        shelfCache = null;
      });
    }
    return shelfCache.shelves;
  },

  async getTitle(id: string) {
    const t = await getManga(id);
    return t ? toSourceTitle(t, 512) : null;
  },

  async listChapters(titleId: string): Promise<SourceChapter[]> {
    const chapters = await listChapters(titleId, { sort: 'asc' });
    return chapters.map((c) => ({
      id: c.id,
      chapter: c.chapter,
      title: c.title,
      volume: c.volume,
      language: c.language,
      pages: c.pages,
      scanlator: c.scanlator,
      publishedAt: c.publishAt,
      externalUrl: c.externalUrl,
    }));
  },

  async chapterPages(chapterId: string): Promise<PageImage[]> {
    const atHome = await getAtHomeServer(chapterId);
    if (!atHome) throw new Error('unable to reach at-home server for chapter');
    const useSaver = config.mangadex.quality === 'data-saver';
    const files = useSaver ? atHome.dataSaverFiles : atHome.files;
    // The quality segment comes before the hash: `/data-saver/{hash}/{file}`.
    // The old inline URL put it after, so MDX_QUALITY=data-saver only ever 404'd.
    const segment = useSaver ? 'data-saver' : 'data';
    return files.map((file) => ({
      url: `${atHome.baseUrl}/${segment}/${atHome.hash}/${file}`,
    }));
  },

  fetchImage(image: PageImage) {
    return downloadImage(image.url);
  },
};
