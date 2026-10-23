/** How MangaDex's chapters are listed, against a stand-in for its HTTP API. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listChapters } from '../src/api/mangadex';

interface Row {
  id: string;
  chapter: string | null;
  lang: string;
  pages?: number;
  externalUrl?: string | null;
}

const row = (n: number | null, lang: string, extra: Partial<Row> = {}): Row => ({
  id: `${n ?? 'x'}-${lang}`,
  chapter: n === null ? null : String(n),
  lang,
  ...extra,
});

const raw = (r: Row) => ({
  id: r.id,
  attributes: {
    chapter: r.chapter,
    translatedLanguage: r.lang,
    pages: r.pages ?? 12,
    externalUrl: r.externalUrl ?? null,
    title: null,
    volume: null,
    publishAt: '2026-01-01T00:00:00+00:00',
  },
  relationships: [],
});

/** Requests the stand-in received, in order. */
let requests: URL[] = [];

/**
 * Serves `pick(url)` in pages of the requested size. A status other than 200
 * stands in for an outage; 404 because it is not retried, where a 5xx would
 * wait out several back-offs.
 */
function serve(pick: (url: URL) => Row[], failAt?: (url: URL) => boolean) {
  requests = [];
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    if (failAt?.(url)) return new Response('{}', { status: 404 });
    const rows = pick(url);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    return Response.json({ result: 'ok', total: rows.length, offset, limit, data: rows.slice(offset, offset + limit).map(raw) });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listing a series', () => {
  it('reads the feed, five hundred chapters a request', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row(i + 1, 'en'));
    serve(() => rows);

    const chapters = await listChapters('manga-1');
    expect(chapters).toHaveLength(1200);
    expect(chapters.map((c) => c.chapter).slice(0, 3)).toEqual(['1', '2', '3']);
    expect(requests.map((u) => u.pathname)).toEqual(Array(3).fill('/manga/manga-1/feed'));
    expect(requests.map((u) => u.searchParams.get('offset'))).toEqual(['0', '500', '1000']);
    expect(requests[0].searchParams.get('limit')).toBe('500');
  });

  it('leaves out chapters that only exist elsewhere or have no pages', async () => {
    serve(() => [
      row(1, 'en'),
      row(2, 'en', { externalUrl: 'https://publisher.example/2' }),
      row(3, 'en', { pages: 0 }),
    ]);
    expect((await listChapters('m')).map((c) => c.chapter)).toEqual(['1']);
  });

  it('fails when a page cannot be read, instead of returning what it had', async () => {
    const rows = Array.from({ length: 700 }, (_, i) => row(i + 1, 'en'));
    serve(() => rows, (url) => url.searchParams.get('offset') === '500');
    await expect(listChapters('m')).rejects.toThrow('could not list the chapters (offset 500)');

    serve(() => rows, () => true);
    await expect(listChapters('m')).rejects.toThrow('could not list the chapters (offset 0)');
  });
});

describe('listing only what changed', () => {
  it('asks for what was edited and what was published since, and merges the two', async () => {
    const edited = [row(8, 'en'), row(9, 'en')];
    const published = [row(9, 'en'), row(10, 'en')];
    serve((url) => (url.searchParams.has('updatedAtSince') ? edited : published));

    const chapters = await listChapters('m', { since: new Date('2026-03-04T05:06:07.890Z') });
    expect(chapters.map((c) => c.chapter)).toEqual(['8', '9', '10']);
    expect(requests).toHaveLength(2);
    // The shape the API accepts: UTC, to the second, no zone suffix.
    expect(requests[0].searchParams.get('updatedAtSince')).toBe('2026-03-04T05:06:07');
    expect(requests[1].searchParams.get('publishAtSince')).toBe('2026-03-04T05:06:07');
  });

  it('is not an outage when nothing changed', async () => {
    serve(() => []);
    expect(await listChapters('m', { since: new Date() })).toEqual([]);
  });
});

describe('which translation of a chapter wins', () => {
  const series = [
    row(1, 'pt-br'),
    row(1, 'es-la'),
    row(2, 'pt-br'),
    row(2, 'es-la'),
    row(3, 'es-la'),
  ];
  const languages = async (opts = {}) => (await listChapters('m', opts)).map((c) => c.language);

  it('goes to the language that covers most of the series when the pipeline cannot tell them apart', async () => {
    serve(() => series);
    // Portuguese and Spanish read equally well; Spanish has all three chapters.
    expect(await languages()).toEqual(['es-la', 'es-la', 'es-la']);
  });

  it('goes to the language the library already holds, before coverage', async () => {
    serve(() => series);
    expect(await languages({ prefer: ['pt-br'] })).toEqual(['pt-br', 'pt-br', 'es-la']);
  });

  it('never gives up a language the pipeline reads better', async () => {
    serve(() => [...series, row(2, 'en')]);
    expect(await languages({ prefer: ['pt-br'] })).toEqual(['pt-br', 'en', 'es-la']);
  });
});
