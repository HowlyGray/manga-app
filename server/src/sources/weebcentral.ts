/**
 * WeebCentral as a `SourceProvider`.
 *
 * It has no API, so this parses its HTML. The markup is narrow and regular
 * (each page is server-rendered from templates), and every pattern below is
 * anchored on a structural landmark -- a canonical link, a `<strong>` label, a
 * `/chapters/<id>` href -- rather than on styling, so a theme change does not
 * break it. Anything that fails to parse yields an empty result instead of
 * throwing, so one changed page cannot take the library down.
 *
 * Chapters here are English, which is also the language the OCR chain reads
 * best -- useful for the many series whose English releases MangaDex lost to
 * the 2025 takedowns.
 */
import { config } from '../config';
import { RateLimiter } from '../util/net';
import type {
  PageImage,
  SourceChapter,
  SourceProvider,
  SourceSearch,
  SourceShelf,
  SourceTitle,
} from './types';

const BASE = 'https://weebcentral.com';

const limiter = new RateLimiter(config.weebcentral.intervalMs);

/** WeebCentral serves plain HTML but rejects requests without a browser UA. */
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  Referer: `${BASE}/`,
};

async function getHtml(url: string): Promise<string> {
  return limiter.run(async () => {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`WeebCentral HTTP ${res.status} for ${url}`);
    return res.text();
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|[a-z]+);/gi, (whole, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known) return known;
    const numeric = /^#(\d+)$/.exec(name);
    return numeric ? String.fromCharCode(Number(numeric[1])) : whole;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : null;
}

/**
 * Reads one of the `<strong>Label: </strong>…</li>` rows in the details list.
 * Returns each anchor or span inside the row as a separate value.
 */
function labelledValues(html: string, label: string): string[] {
  const re = new RegExp(`<strong>\\s*${label}\\s*:?\\s*</strong>([\\s\\S]*?)</li>`, 'i');
  const block = re.exec(html);
  if (!block) return [];
  const values: string[] = [];
  const item = /<(?:a|span)\b[^>]*>([\s\S]*?)<\/(?:a|span)>/gi;
  let hit: RegExpExecArray | null;
  while ((hit = item.exec(block[1])) !== null) {
    const value = stripTags(hit[1]).replace(/,$/, '').trim();
    if (value) values.push(value);
  }
  return values;
}

function coverUrl(id: string): string {
  return `https://temp.compsci88.com/cover/fallback/${id}.jpg`;
}

function parseSearchResults(html: string): SourceTitle[] {
  const seen = new Set<string>();
  const titles: SourceTitle[] = [];
  const re = /href="https:\/\/weebcentral\.com\/series\/([0-9A-Za-z]+)\/[^"]*"[\s\S]{0,1200}?alt="([^"]*?) cover"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, id, rawTitle] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    titles.push({
      id,
      title: decodeEntities(rawTitle).trim() || id,
      altTitles: [],
      originalLang: null,
      synopsis: null,
      status: null,
      year: null,
      author: null,
      contentRating: null,
      tags: [],
      coverUrl: coverUrl(id),
    });
  }
  return titles;
}

export const weebcentralProvider: SourceProvider = {
  id: 'weebcentral',
  label: 'WeebCentral',
  browsable: true,
  maxOffset: null,

  async search(params: SourceSearch) {
    const limit = Math.min(50, Math.max(1, params.limit ?? 24));
    const offset = Math.max(0, params.offset ?? 0);
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      text: params.q ?? '',
      // The site offers no tag or date filters on this endpoint, so anything
      // beyond a term and an order is silently ignored.
      sort: params.sort === 'latest' ? 'Latest Updates' : params.q ? 'Best Match' : 'Popularity',
      order: 'Descending',
      display_mode: 'Full Display',
    });

    const html = await getHtml(`${BASE}/search/data?${query.toString()}`);
    // The site treats `limit` as a hint and can return more, so honour the
    // caller's page size here -- the pager's arithmetic depends on it.
    // It reports no result count anywhere, so the pager runs blind.
    return { total: null, titles: parseSearchResults(html).slice(0, limit) };
  },

  async getTitle(id: string): Promise<SourceTitle | null> {
    let html: string;
    try {
      html = await getHtml(`${BASE}/series/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }

    const title =
      firstMatch(html, /<meta property="og:title" content="([^"]*?)(?: \| Weeb Central)?">/) ??
      firstMatch(html, /<title>([^<]*?)(?: \| Weeb Central)?<\/title>/);
    if (!title) return null;

    const released = labelledValues(html, 'Released')[0];
    const year = Number(released);
    const authors = labelledValues(html, 'Author\\(s\\)');
    const adult = labelledValues(html, 'Adult Content')[0];
    const description = /<p class="whitespace-pre-wrap break-words">([\s\S]*?)<\/p>/.exec(html);

    return {
      id,
      title,
      altTitles: labelledValues(html, 'Associated Name\\(s\\)'),
      originalLang: null,
      synopsis: description ? stripTags(description[1]) : null,
      status: labelledValues(html, 'Status')[0] ?? null,
      year: Number.isFinite(year) && year > 1000 ? year : null,
      author: authors.length > 0 ? authors.join(', ') : null,
      contentRating: adult === 'Yes' ? 'erotica' : 'safe',
      tags: labelledValues(html, 'Tags?\\(s\\)'),
      coverUrl: coverUrl(id),
    };
  },

  async listChapters(titleId: string): Promise<SourceChapter[]> {
    let html: string;
    try {
      html = await getHtml(`${BASE}/series/${encodeURIComponent(titleId)}/full-chapter-list`);
    } catch {
      return [];
    }

    const chapters: SourceChapter[] = [];
    // Each row is an anchor to /chapters/<id> wrapping the chapter's label, and
    // carries its publication date in the x-data attribute above it.
    const re =
      /checkNewChapter\('([^']*)'\)[\s\S]{0,400}?href="\/chapters\/([0-9A-Za-z]+)"[\s\S]*?<span class="">([\s\S]*?)<\/span>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const [, publishedAt, id, rawLabel] = m;
      const label = stripTags(rawLabel);
      const number = /([\d.]+)\s*$/.exec(label)?.[1] ?? null;
      chapters.push({
        id,
        chapter: number,
        title: number ? null : label || null,
        volume: null,
        language: 'en',
        pages: null,
        scanlator: null,
        publishedAt: publishedAt || null,
        externalUrl: null,
      });
    }

    // The site lists newest first; the library expects ascending order.
    return chapters.reverse();
  },

  async chapterPages(chapterId: string): Promise<PageImage[]> {
    const query = new URLSearchParams({
      is_prev: 'False',
      current_page: '1',
      reading_style: 'long_strip',
    });
    const html = await getHtml(
      `${BASE}/chapters/${encodeURIComponent(chapterId)}/images?${query.toString()}`,
    );

    const urls: string[] = [];
    const re = /<img[^>]+src="(https:\/\/[^"]+\.(?:png|jpg|jpeg|webp))"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) urls.push(m[1]);
    if (urls.length === 0) throw new Error(`no page images for chapter ${chapterId}`);
    // The image host serves these only for a WeebCentral referer.
    return urls.map((url) => ({ url, headers: { Referer: `${BASE}/` } }));
  },

  fetchImage(image: PageImage) {
    return fetch(image.url, { headers: { ...HEADERS, ...image.headers } });
  },

  /**
   * No tag vocabulary is exposed here, so `listTags` is deliberately absent and
   * the UI hides genre browsing for this source rather than showing an empty
   * picker.
   */
  async homeShelves(): Promise<SourceShelf[]> {
    const shelves: SourceShelf[] = [];
    for (const spec of [
      { id: 'popular', title: 'Popular on WeebCentral', subtitle: 'Most read overall', sort: 'popular' as const },
      { id: 'latest', title: 'Fresh chapters', subtitle: 'Updated most recently', sort: 'latest' as const },
    ]) {
      try {
        const { titles } = await weebcentralProvider.search({ sort: spec.sort, limit: 18 });
        if (titles.length > 0) {
          shelves.push({ id: spec.id, title: spec.title, subtitle: spec.subtitle, titles, browse: { sort: spec.sort } });
        }
      } catch (err) {
        console.error(`[home] shelf ${spec.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return shelves;
  },
};
