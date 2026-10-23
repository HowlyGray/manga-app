/**
 * Read state through the HTTP API, on a fake content source: previews and
 * imports need a provider, and the real ones would reach the network.
 */
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerProvider, type SourceChapter, type SourceProvider } from '../src/sources';
import { startApp } from './http';

const TITLE = 'fake:series';

const CHAPTERS: SourceChapter[] = [1, 2, 3].map((n) => ({
  id: `ch${n}`,
  chapter: String(n),
  title: null,
  volume: null,
  language: 'en',
  pages: 2,
  scanlator: null,
  publishedAt: null,
  externalUrl: null,
}));

let png: Buffer;

const fake: SourceProvider = {
  id: 'fake',
  label: 'Fake',
  browsable: true,
  maxOffset: null,
  async search() {
    return { titles: [], total: 0 };
  },
  async getTitle(id) {
    if (id !== 'series') return null;
    return {
      id,
      title: 'Fake Series',
      altTitles: [],
      originalLang: 'ja',
      synopsis: null,
      status: 'ongoing',
      year: 2024,
      author: null,
      contentRating: 'safe',
      tags: [],
      coverUrl: null,
    };
  },
  async listChapters() {
    return CHAPTERS;
  },
  async chapterPages() {
    return [{ url: 'https://fake.invalid/1.png' }, { url: 'https://fake.invalid/2.png' }];
  },
  async fetchImage() {
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  },
};

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  png = await createCanvas(8, 8).encode('png');
  registerProvider(fake);
  app = await startApp();
});

afterAll(() => {
  app.close();
});

const detail = async () => (await app.request(`/api/library/${TITLE}`)).json();

const read = (chapterId: string, page: number) =>
  app.request('/api/progress', {
    method: 'POST',
    json: { titleId: TITLE, chapterId, page, pages: 2, mode: 'scroll' },
  });

const mark = (chapterId: string, finished: unknown) =>
  app.request(`/api/library/${TITLE}/chapters/${chapterId}/read`, { method: 'POST', json: { finished } });

describe('titles outside the library', () => {
  it('lists their chapters under library ids', async () => {
    const d = await detail();
    expect(d.inLibrary).toBe(false);
    // Bare provider ids used to come back here, which the id check refuses and
    // which downloading could not find.
    expect(d.chapters.items.map((c: { id: string }) => c.id)).toEqual(['fake:ch1', 'fake:ch2', 'fake:ch3']);
    expect(d.progress).toBeNull();
  });

  it('previews a chapter from a source other than MangaDex', async () => {
    const chapter = await app.request(`/api/preview/${TITLE}/fake:ch1`);
    expect(chapter.status).toBe(200);
    expect(chapter.json()).toMatchObject({ preview: true, chapter: { chapter: '1', pages: 2 } });
    const page = await app.request(`/api/preview/${TITLE}/fake:ch1/2`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('image/png');
  });
});

describe('reading progress', () => {
  it('is remembered for a chapter read in preview', async () => {
    expect((await read('fake:ch1', 1)).status).toBe(200);
    const d = await detail();
    expect(d.chapters.items[0].read).toEqual({ page: 1, pages: 2, finished: false });
    expect(d.progress).toMatchObject({ chapter_id: 'fake:ch1', page: 1 });
  });

  it('finishes a chapter on its last page, and scrolling back keeps it finished', async () => {
    await read('fake:ch1', 2);
    await read('fake:ch1', 1);
    expect((await detail()).chapters.items[0].read).toEqual({ page: 1, pages: 2, finished: true });
  });

  it('marks chapters read and unread by hand', async () => {
    expect((await mark('fake:ch2', true)).status).toBe(200);
    let d = await detail();
    expect(d.chapters.items[1].read).toMatchObject({ finished: true });
    // Marking read moves "continue reading" past it.
    expect(d.progress.chapter_id).toBe('fake:ch2');

    await mark('fake:ch2', false);
    d = await detail();
    expect(d.chapters.items[1].read).toMatchObject({ finished: false, page: 0 });
    expect((await mark('fake:ch2', 'yes')).status).toBe(400);
  });

  it('carries over when the title is saved, and counts in the library', async () => {
    expect((await app.request('/api/library/import', { method: 'POST', json: { id: TITLE } })).status).toBe(200);
    const d = await detail();
    expect(d.inLibrary).toBe(true);
    expect(d.chapters.items[0].read).toMatchObject({ finished: true });
    const library = (await app.request('/api/library')).json();
    expect(library.find((t: { id: string }) => t.id === TITLE)).toMatchObject({
      total_chapters: 3,
      read_chapters: 1,
    });
  });
});
