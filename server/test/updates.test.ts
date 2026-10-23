/** The library-wide check for new chapters, on a fake source the test controls. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerProvider, type SourceChapter, type SourceProvider } from '../src/sources';
import { sleep } from '../src/util/net';
import { startApp } from './http';

const TITLE = 'upd:series';

function chapter(n: number, language = 'en'): SourceChapter {
  return {
    id: language === 'en' ? `c${n}` : `c${n}-${language}`,
    chapter: String(n),
    title: null,
    volume: null,
    language,
    pages: 10,
    scanlator: null,
    publishedAt: null,
    externalUrl: null,
  };
}

/** An extra or one-shot: sources leave the number out. */
function unnumbered(id: string): SourceChapter {
  return { ...chapter(0), id, chapter: null };
}

const chapters: SourceChapter[] = [chapter(1), chapter(2)];
let sourceDown = false;

const provider: SourceProvider = {
  id: 'upd',
  label: 'Updates test',
  browsable: false,
  maxOffset: null,
  async search() {
    return { titles: [], total: 0 };
  },
  async getTitle(id) {
    return {
      id,
      title: 'Update Series',
      altTitles: [],
      originalLang: 'ko',
      synopsis: null,
      status: 'ongoing',
      year: null,
      author: null,
      contentRating: 'safe',
      tags: [],
      coverUrl: null,
    };
  },
  async listChapters() {
    if (sourceDown) throw new Error('source down');
    return [...chapters];
  },
  async chapterPages() {
    return [];
  },
  async fetchImage() {
    return new Response(null, { status: 404 });
  },
};

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  registerProvider(provider);
  app = await startApp();
  expect((await app.request('/api/library/import', { method: 'POST', json: { id: TITLE } })).status).toBe(200);
});

afterAll(() => {
  app.close();
});

async function runCheck() {
  await app.request('/api/library/check-updates', { method: 'POST' });
  for (let i = 0; i < 100; i++) {
    const status = (await app.request('/api/library/check-updates')).json();
    if (!status.running) return status;
    await sleep(20);
  }
  throw new Error('update check did not finish');
}

const entry = async () => (await app.request('/api/library')).json().find((t: { id: string }) => t.id === TITLE);
const newCount = async () => (await entry()).new_chapters;
const open = () => app.request(`/api/library/${TITLE}/seen`, { method: 'POST' });
const markRead = (chapterId: string) =>
  app.request(`/api/library/${TITLE}/chapters/${chapterId}/read`, { method: 'POST', json: { finished: true } });

describe('checking the library for new chapters', () => {
  it('shows nothing new right after an import', async () => {
    expect(await newCount()).toBe(0);
  });

  it('finds new chapter numbers, but not new translations of old ones', async () => {
    // Timestamps have one-second resolution; the check has to land after the import.
    await sleep(1100);
    chapters.push(chapter(3), chapter(2, 'pt-br'));
    const status = await runCheck();
    expect(status).toMatchObject({ total: 1, checked: 1, found: 1, failed: [] });
    expect(await newCount()).toBe(1);

    const detail = (await app.request(`/api/library/${TITLE}`)).json();
    const flags = Object.fromEntries(detail.chapters.items.map((c: { id: string; isNew: boolean }) => [c.id, c.isNew]));
    // The Portuguese copy of 2 is not stored: English, already held, reads at least as well.
    expect(flags).toEqual({ 'upd:c1': false, 'upd:c2': false, 'upd:c3': true });
  });

  it('stops counting them once the title has been opened', async () => {
    await open();
    expect(await newCount()).toBe(0);
  });

  it('counts a chapter number that arrives in two languages once', async () => {
    await sleep(1100);
    chapters.push(chapter(4), chapter(4, 'es'));
    expect((await runCheck()).found).toBe(1);
    expect(await newCount()).toBe(1);
    await open();
  });

  it('counts each chapter without a number on its own', async () => {
    await sleep(1100);
    chapters.push(unnumbered('extra-a'));
    expect((await runCheck()).found).toBe(1);
    await open();
    // An extra seen before must not pass for the one that just arrived.
    await sleep(1100);
    chapters.push(unnumbered('extra-b'));
    expect((await runCheck()).found).toBe(1);
    expect(await newCount()).toBe(1);
  });

  it('counts chapters and reads by number, not by stored copy', async () => {
    // A second translation is stored when someone asks for that exact chapter.
    expect((await app.request(`/api/library/${TITLE}/chapters/upd:c2-pt-br/download`, { method: 'POST' })).status).toBe(200);
    // 1, 2 (en + pt-br), 3, 4 (en + es) and the two extras.
    expect(await entry()).toMatchObject({ total_chapters: 6, read_chapters: 0 });
    expect((await markRead('upd:c2-pt-br')).status).toBe(200);
    expect((await markRead('upd:c2')).status).toBe(200);
    expect((await entry()).read_chapters).toBe(1);
  });

  it('reports titles whose source fails, and carries on', async () => {
    sourceDown = true;
    const status = await runCheck();
    expect(status.failed).toEqual([{ id: TITLE, title: 'Update Series', error: 'source down' }]);
    expect(status.checked).toBe(1);
    sourceDown = false;
  });
});
