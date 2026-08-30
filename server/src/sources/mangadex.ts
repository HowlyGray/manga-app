/** MangaDex as a `SourceProvider`; the HTTP client itself lives in api/mangadex. */
import { config } from '../config';
import {
  coverThumbUrl,
  downloadImage,
  getAtHomeServer,
  getManga,
  listChapters,
  searchManga,
  type MangaDexTitle,
} from '../api/mangadex';
import type { PageImage, SourceChapter, SourceProvider, SourceSearch, SourceTitle } from './types';

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

export const mangadexProvider: SourceProvider = {
  id: 'mangadex',
  label: 'MangaDex',
  browsable: true,

  async search(params: SourceSearch) {
    const { titles, total } = await searchManga({
      q: params.q,
      lang: params.lang as never,
      limit: params.limit,
      offset: params.offset,
    });
    return { total, titles: titles.map((t) => toSourceTitle(t, 256)) };
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
