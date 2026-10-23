/**
 * Keeping saved titles current, on fake sources the test controls: what a
 * refresh asks the source for, what it keeps, and what a failing source must
 * not be mistaken for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db';
import { refreshTitle } from '../src/services/ingest';
import * as lib from '../src/services/library';
import {
  registerProvider,
  type ListChaptersOptions,
  type SourceChapter,
  type SourceProvider,
  type SourceTitle,
} from '../src/sources';
import { sleep } from '../src/util/net';
import { startApp } from './http';

const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

interface Series {
  details: SourceTitle;
  /** Each chapter with the moment it appeared on the source. */
  chapters: { chapter: SourceChapter; appeared: Date }[];
}

const catalogue = new Map<string, Series>();
const calls: { provider: string; id: string; since: Date | undefined }[] = [];
const down = new Set<string>();

function details(id: string, over: Partial<SourceTitle> = {}): SourceTitle {
  return {
    id,
    title: `Series ${id}`,
    altTitles: [],
    originalLang: 'ja',
    synopsis: 'A story.',
    status: 'ongoing',
    year: 2020,
    author: 'Someone',
    contentRating: 'safe',
    tags: ['Action'],
    coverUrl: null,
    ...over,
  };
}

/** Chapter factory for one series, so ids stay unique across the library. */
const chapterOf =
  (series: string) =>
  (n: number | null, language = 'en'): SourceChapter => ({
    id: `${series}-${n ?? 'extra'}-${language}`,
    chapter: n === null ? null : String(n),
    title: null,
    volume: null,
    language,
    pages: 10,
    scanlator: null,
    publishedAt: null,
    externalUrl: null,
  });

/** An incremental source: listing with `since` returns only what appeared after it. */
function fakeSource(key: string, delayMs = 0): SourceProvider {
  return {
    id: key,
    label: `Fake ${key}`,
    browsable: false,
    maxOffset: null,
    incremental: true,
    async search() {
      return { titles: [], total: 0 };
    },
    async getTitle(id) {
      return catalogue.get(`${key}:${id}`)?.details ?? null;
    },
    async listChapters(id: string, opts?: ListChaptersOptions) {
      calls.push({ provider: key, id, since: opts?.since });
      if (delayMs) await sleep(delayMs);
      if (down.has(key)) throw new Error('source down');
      const since = opts?.since;
      return (catalogue.get(`${key}:${id}`)?.chapters ?? [])
        .filter((c) => !since || c.appeared >= since)
        .map((c) => c.chapter);
    },
    async chapterPages() {
      return [];
    },
    async fetchImage() {
      return new Response(null, { status: 404 });
    },
  };
}

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  for (const key of ['inc', 'slow', 'gone']) registerProvider(fakeSource(key, key === 'slow' ? 100 : 0));
  app = await startApp();
});

afterAll(() => {
  app.close();
});

beforeEach(() => {
  down.clear();
  calls.length = 0;
});

/** Puts a series on a source and imports it, as adding it from the browse page does. */
async function importSeries(
  key: string,
  id: string,
  chapters: SourceChapter[],
  over: Partial<SourceTitle> = {},
): Promise<string> {
  catalogue.set(`${key}:${id}`, {
    details: details(id, over),
    chapters: chapters.map((chapter) => ({ chapter, appeared: ago(24 * HOUR) })),
  });
  const res = await app.request('/api/library/import', { method: 'POST', json: { id: `${key}:${id}` } });
  expect(res.status).toBe(200);
  return `${key}:${id}`;
}

const appear = (id: string, chapter: SourceChapter, when = ago(HOUR)) =>
  catalogue.get(id)!.chapters.push({ chapter, appeared: when });

async function runCheck(query = '') {
  const started = (await app.request(`/api/library/check-updates${query}`, { method: 'POST' })).json();
  if (!started.running) return started;
  for (let i = 0; i < 300; i++) {
    const status = (await app.request('/api/library/check-updates')).json();
    if (!status.running) return status;
    await sleep(20);
  }
  throw new Error('update check did not finish');
}

/** Every saved title counts as just checked, so a test controls which are due. */
function settle() {
  for (const t of lib.listLibrary()) lib.markChecked(t.id);
}

const entry = async (id: string) =>
  (await app.request('/api/library')).json().find((t: { id: string }) => t.id === id);

describe('what a refresh asks the source for', () => {
  it('lists everything once, then only what changed since the last check', async () => {
    const c = chapterOf('a');
    const id = await importSeries('inc', 'a', [c(1), c(2)]);

    await refreshTitle(id);
    const asked = calls.at(-1)!.since!;
    // The last check began a moment ago; the look-back is half an hour before it.
    expect(Date.now() - asked.getTime()).toBeGreaterThanOrEqual(30 * 60_000);
    expect(Date.now() - asked.getTime()).toBeLessThan(31 * 60_000);

    await refreshTitle(id, { full: true });
    expect(calls.at(-1)!.since).toBeUndefined();

    getDb().prepare('UPDATE titles SET checked_at = NULL WHERE id = ?').run(id);
    expect((await refreshTitle(id)).incremental).toBe(false);
    expect(calls.at(-1)!.since).toBeUndefined();
  });

  it('finds a chapter that appeared after the last check, and calls it news', async () => {
    const c = chapterOf('b');
    const id = await importSeries('inc', 'b', [c(1), c(2)]);
    lib.markChecked(id, ago(2 * HOUR));
    appear(id, c(3));

    expect(await refreshTitle(id)).toMatchObject({ added: 1, news: 1, fresh: ['inc:b-3-en'], incremental: true });
    expect(lib.getChapter(id, 'inc:b-3-en')).not.toBeNull();
  });

  /** A series stored in a mixed bag of languages, with translations that arrived since. */
  async function seriesWithBetterTranslations(name: string) {
    const c = chapterOf(name);
    const id = await importSeries('inc', name, [c(1), c(2), c(5, 'ar')]);
    lib.markChecked(id, ago(2 * HOUR));
    appear(id, c(2, 'pt-br')); // English is held: no better
    appear(id, c(5, 'en')); // better than the Arabic held
    appear(id, c(6, 'pt-br')); // a chapter it lacks
    return id;
  }

  it('only adds the chapters it lacks when it checks by itself', async () => {
    const id = await seriesWithBetterTranslations('m');
    const result = await refreshTitle(id);
    expect(result).toMatchObject({ added: 1, fresh: ['inc:m-6-pt-br'], news: 1 });
    expect(lib.listChapters(id).map((x) => x.id).sort()).toEqual(
      ['inc:m-1-en', 'inc:m-2-en', 'inc:m-5-ar', 'inc:m-6-pt-br'],
    );
  });

  it('does the same on a first check that lists everything', async () => {
    const id = await seriesWithBetterTranslations('m1');
    getDb().prepare('UPDATE titles SET checked_at = NULL WHERE id = ?').run(id);
    const result = await refreshTitle(id);
    expect(result).toMatchObject({ added: 1, fresh: ['inc:m1-6-pt-br'], incremental: false });
    expect(lib.listChapters(id)).toHaveLength(4);
  });

  it('offers a translation that reads better when asked for everything, and not one that does not', async () => {
    const id = await seriesWithBetterTranslations('m2');
    const result = await refreshTitle(id, { full: true });
    // The English chapter 5 sits next to the Arabic one; it is not news.
    expect(result).toMatchObject({ added: 2, upgrades: 1, fresh: ['inc:m2-6-pt-br'], news: 1 });
    const held = lib.listChapters(id).map((x) => x.id);
    expect(held).toContain('inc:m2-5-en');
    expect(held).not.toContain('inc:m2-2-pt-br');
  });

  it('does not stack a second copy when a full listing picks another language that reads as well', async () => {
    const c = chapterOf('q');
    const id = await importSeries('inc', 'q', [c(1, 'es-la'), c(2, 'es-la')]);
    // The source now offers Portuguese for the same numbers, and one more chapter.
    catalogue.get('inc:q')!.chapters = [1, 2, 3].map((n) => ({ chapter: c(n, 'pt-br'), appeared: ago(24 * HOUR) }));

    const result = await refreshTitle(id, { full: true });
    expect(result).toMatchObject({ added: 1, fresh: ['inc:q-3-pt-br'], incremental: false });
    expect(lib.listChapters(id).map((x) => x.id)).toEqual(['inc:q-1-es-la', 'inc:q-2-es-la', 'inc:q-3-pt-br']);
  });

  it('shares one refresh between callers that ask at once', async () => {
    const c = chapterOf('s');
    const id = await importSeries('slow', 's', [c(1)]);
    lib.markChecked(id, ago(2 * HOUR));
    calls.length = 0;
    const [one, two] = await Promise.all([refreshTitle(id), refreshTitle(id)]);
    expect(one).toBe(two);
    expect(calls).toHaveLength(1);
  });
});

describe('what a refresh keeps', () => {
  it('updates a title\'s details, and never blanks them out', async () => {
    const c = chapterOf('e');
    const id = await importSeries('inc', 'e', [c(1)], { status: 'ongoing', synopsis: 'First.' });
    catalogue.get('inc:e')!.details = details('e', { status: 'completed', synopsis: 'Second.' });
    expect((await refreshTitle(id)).detailsChanged).toBe(true);
    expect(lib.getTitle(id)).toMatchObject({ status: 'completed', synopsis: 'Second.' });

    // A source that leaves fields empty must not erase what the library knows.
    catalogue.get('inc:e')!.details = details('e', { synopsis: null, tags: [], author: null, status: null });
    expect((await refreshTitle(id)).detailsChanged).toBe(false);
    expect(lib.getTitle(id)).toMatchObject({
      status: 'completed',
      synopsis: 'Second.',
      tags: ['Action'],
      author: 'Someone',
    });
  });

  it('leaves the library in the order titles were added', async () => {
    const first = await importSeries('inc', 'f1', [chapterOf('f1')(1)]);
    const second = await importSeries('inc', 'f2', [chapterOf('f2')(1)]);
    const order = () => lib.listLibrary().map((t) => t.id).filter((id) => id === first || id === second);
    expect(order()).toEqual([second, first]);

    catalogue.get('inc:f1')!.details = details('f1', { status: 'completed' });
    expect((await refreshTitle(first)).detailsChanged).toBe(true);
    expect(order()).toEqual([second, first]);
  });

  it('keeps what is new when a title that is already saved is imported again', async () => {
    const c = chapterOf('k');
    const id = await importSeries('inc', 'k', [c(1)]);
    await sleep(1100); // timestamps have one-second resolution
    appear(id, c(2));
    lib.markChecked(id, ago(2 * HOUR));
    await refreshTitle(id);
    expect((await entry(id)).new_chapters).toBe(1);

    expect((await app.request('/api/library/import', { method: 'POST', json: { id } })).status).toBe(200);
    expect((await entry(id)).new_chapters).toBe(1);
  });
});

describe('a source that fails', () => {
  it('is not taken for a title with nothing new', async () => {
    const c = chapterOf('d');
    const id = await importSeries('inc', 'd', [c(1), c(2)]);
    lib.markChecked(id, ago(5 * HOUR));
    const before = lib.getChecked(id);

    down.add('inc');
    await expect(refreshTitle(id)).rejects.toThrow('source down');
    expect(lib.getChecked(id)).toEqual(before);

    // Neither is an empty answer for a title that has chapters.
    down.clear();
    catalogue.get(id)!.chapters = [];
    await expect(refreshTitle(id, { full: true })).rejects.toThrow('Fake inc returned no chapters');
    expect(lib.getChecked(id)).toEqual(before);

    // An incremental check with nothing new is a normal answer, though.
    expect(await refreshTitle(id)).toMatchObject({ added: 0, news: 0 });
    expect(lib.getChecked(id)!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it('leaves nothing behind when a title cannot be imported', async () => {
    catalogue.set('inc:l', { details: details('l'), chapters: [] });
    down.add('inc');
    const res = await app.request('/api/library/import', { method: 'POST', json: { id: 'inc:l' } });
    expect(res.status).toBe(502);
    expect(lib.getTitle('inc:l')).toBeNull();
  });
});

describe('reading a chapter a check just found', () => {
  it('does not list the whole title at its source first', async () => {
    const c = chapterOf('pv');
    const id = await importSeries('inc', 'pv', [c(1), c(2)]);
    lib.markChecked(id, ago(2 * HOUR));
    appear(id, c(3));
    await refreshTitle(id);
    calls.length = 0;

    const res = await app.request(`/api/preview/${id}/inc:pv-3-en`);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ preview: true, chapter: { chapter: '3', language: 'en' } });
    expect(calls).toEqual([]);
  });
});

describe('the refresh routes', () => {
  it('answers from the last check while it is recent, and lists again when asked to', async () => {
    const id = await importSeries('inc', 'g', [chapterOf('g')(1)]);
    const mine = () => calls.filter((c) => c.id === 'g');
    calls.length = 0;

    const recent = (await app.request(`/api/library/${id}/refresh`, { method: 'POST' })).json();
    expect(recent).toMatchObject({ refreshed: false, added: 0, fresh: [] });
    expect(mine()).toHaveLength(0);

    const forced = (await app.request(`/api/library/${id}/refresh?full=1`, { method: 'POST' })).json();
    expect(forced).toMatchObject({ refreshed: true, incremental: false });
    expect(mine()).toEqual([{ provider: 'inc', id: 'g', since: undefined }]);
  });

  it('refuses a title that is not saved and reports a source that is down', async () => {
    expect((await app.request('/api/library/inc:nowhere/refresh', { method: 'POST' })).status).toBe(404);

    const id = await importSeries('inc', 'h', [chapterOf('h')(1)]);
    lib.markChecked(id, ago(HOUR));
    down.add('inc');
    const res = await app.request(`/api/library/${id}/refresh`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(res.json()).toEqual({ error: 'source down' });
  });
});

describe('the library-wide check', () => {
  it('only looks at titles whose last check is old, when the app is opened', async () => {
    const fresh = await importSeries('inc', 'n1', [chapterOf('n1')(1)]);
    const stale = await importSeries('inc', 'n2', [chapterOf('n2')(1)]);
    settle();
    lib.markChecked(stale, ago(4 * HOUR));
    calls.length = 0;

    const job = await runCheck('?stale=1');
    expect(job).toMatchObject({ total: 1, checked: 1, failed: [] });
    expect(calls.map((c) => c.id)).toEqual(['n2']);
    expect(Date.now() - lib.getChecked(stale)!.getTime()).toBeLessThan(60_000);
    expect(lib.getChecked(fresh)).not.toBeNull();

    // Nothing is due any more, and the answer says so without a new check.
    expect(await runCheck('?stale=1')).toMatchObject({ running: false, total: 0 });
  });

  it('holds back a title that just failed, until it is asked for by hand', async () => {
    settle();
    const flaky = await importSeries('inc', 'p', [chapterOf('p')(1)]);
    lib.markChecked(flaky, ago(4 * HOUR));

    down.add('inc');
    const first = await runCheck('?stale=1');
    expect(first.failed).toEqual([{ id: flaky, title: 'Series p', error: 'source down' }]);
    expect((await runCheck('?stale=1')).total).toBe(0);

    down.clear();
    const manual = await runCheck();
    expect(manual.failed).toEqual([]);
    expect(Date.now() - lib.getChecked(flaky)!.getTime()).toBeLessThan(60_000);
  });

  it('gives up on a source after three failures in a row', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) ids.push(await importSeries('gone', `x${n}`, [chapterOf(`x${n}`)(1)]));
    settle();
    calls.length = 0;
    down.add('gone');

    const job = await runCheck();
    const mine = job.failed.filter((f: { id: string }) => ids.includes(f.id));
    expect(mine).toHaveLength(5);
    expect(mine.filter((f: { error: string }) => f.error.startsWith('not tried'))).toHaveLength(2);
    expect(calls.filter((c) => c.provider === 'gone')).toHaveLength(3);
    expect(job.checked).toBe(job.total);
  });

  it('checks each source side by side', async () => {
    await importSeries('slow', 'y1', [chapterOf('y1')(1)]);
    await importSeries('inc', 'y2', [chapterOf('y2')(1)]);
    await importSeries('inc', 'y3', [chapterOf('y3')(1)]);
    settle();
    calls.length = 0;

    await runCheck();
    // Taking sources in turn would start two titles of the same one first.
    expect(calls[0].provider).not.toBe(calls[1].provider);
  });
});
