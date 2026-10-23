/** Disk usage and removal, on a fake source whose downloads the test can hold. */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chapterDir } from '../src/db';
import { registerProvider, type SourceProvider } from '../src/sources';
import { sleep } from '../src/util/net';
import { startApp } from './http';

const TITLE = 'store:series';
const C1 = 'store:c1';
const C2 = 'store:c2';

let png: Buffer;
let gate: Promise<void> = Promise.resolve();
let openGate = () => {};

const provider: SourceProvider = {
  id: 'store',
  label: 'Storage test',
  browsable: false,
  maxOffset: null,
  async search() {
    return { titles: [], total: 0 };
  },
  async getTitle(id) {
    return {
      id,
      title: 'Storage Series',
      altTitles: [],
      originalLang: 'ja',
      synopsis: null,
      status: null,
      year: null,
      author: null,
      contentRating: 'safe',
      tags: [],
      coverUrl: null,
    };
  },
  async listChapters() {
    return ['c1', 'c2'].map((id, i) => ({
      id,
      chapter: String(i + 1),
      title: null,
      volume: null,
      language: 'en',
      pages: 2,
      scanlator: null,
      publishedAt: null,
      externalUrl: null,
    }));
  },
  async chapterPages() {
    return [{ url: 'https://store.invalid/a.png' }, { url: 'https://store.invalid/b.png' }];
  },
  async fetchImage() {
    await gate;
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  },
};

let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  png = await createCanvas(64, 64).encode('png');
  registerProvider(provider);
  app = await startApp();
  expect((await app.request('/api/library/import', { method: 'POST', json: { id: TITLE } })).status).toBe(200);
});

afterAll(() => {
  app.close();
});

async function download(chapterId: string): Promise<void> {
  await app.request(`/api/library/${TITLE}/chapters/${chapterId}/download`, { method: 'POST' });
}

async function waitDownloaded(chapterId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const res = (await app.request(`/api/library/${TITLE}/chapters/${chapterId}`)).json();
    if (res.chapter.downloaded === 1 && !res.chapter.downloading) return;
    await sleep(20);
  }
  throw new Error(`${chapterId} did not finish downloading`);
}

const usage = async () => (await app.request(`/api/library/${TITLE}/usage`)).json();

describe('disk usage and removal', () => {
  it('reports pages, translations and OCR separately', async () => {
    await download(C1);
    await waitDownloaded(C1);
    const dir = chapterDir(TITLE, C1);
    fs.mkdirSync(path.join(dir, '.trl'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.ocr'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.trl', '1.EN.v13.webp'), Buffer.alloc(3000));
    fs.writeFileSync(path.join(dir, '.ocr', '1.en.tesseract.json'), Buffer.alloc(500));

    const u = await usage();
    expect(u).toEqual({ pages: png.length * 2, translations: 3000, ocr: 500 });
    const all = (await app.request('/api/library/usage')).json();
    expect(all.titles).toEqual([{ id: TITLE, ...u }]);
    expect(all.total).toEqual(u);
  });

  it('clears translations but keeps pages and OCR', async () => {
    const res = await app.request(`/api/library/${TITLE}/translations`, { method: 'DELETE' });
    expect(res.json()).toEqual({ freed: 3000 });
    expect(await usage()).toEqual({ pages: png.length * 2, translations: 0, ocr: 500 });
  });

  it("deletes a chapter's files and offers it for download again", async () => {
    const res = await app.request(`/api/library/${TITLE}/chapters/${C1}/files`, { method: 'DELETE' });
    expect(res.json()).toEqual({ freed: png.length * 2 + 500 });
    expect(fs.existsSync(chapterDir(TITLE, C1))).toBe(false);
    const chapter = (await app.request(`/api/library/${TITLE}/chapters/${C1}`)).json();
    expect(chapter.chapter.downloaded).toBe(0);
    expect(chapter.pages).toEqual([]);
  });

  it('will not remove a title while it is downloading', async () => {
    gate = new Promise((resolve) => (openGate = resolve));
    await download(C2);
    const refused = await app.request(`/api/library/${TITLE}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    openGate();
    await waitDownloaded(C2);
  });

  it('removes a title with its files and reading history', async () => {
    await app.request('/api/progress', {
      method: 'POST',
      json: { titleId: TITLE, chapterId: C2, page: 1, pages: 2 },
    });
    const res = await app.request(`/api/library/${TITLE}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.json().freed).toBe(png.length * 2);
    expect(fs.existsSync(path.dirname(chapterDir(TITLE, C2)))).toBe(false);
    expect((await app.request('/api/library')).json()).toEqual([]);
    // Opened again it is a title outside the library, with nothing recorded.
    const detail = (await app.request(`/api/library/${TITLE}`)).json();
    expect(detail).toMatchObject({ inLibrary: false, progress: null });
    expect((await app.request(`/api/library/${TITLE}`, { method: 'DELETE' })).status).toBe(404);
  });
});
