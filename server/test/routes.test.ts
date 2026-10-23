/** The HTTP surface: who may call it, and what it accepts. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp } from './http';

let app: Awaited<ReturnType<typeof startApp>>;
const request: typeof app.request = (...args) => app.request(...args);

beforeAll(async () => {
  app = await startApp();
});

afterAll(() => {
  app.close();
});

const T = '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0';
const C = 'b0b0ce23-98c5-4344-bbed-94c6a4e1ff10';

describe('who may call the API', () => {
  it('answers same-origin requests and sends no CORS headers', async () => {
    const res = await request('/api/ping', {
      headers: { 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(['cross-site', 'same-site'])('refuses requests a browser marks %s', async (site) => {
    expect((await request('/api/ping', { headers: { 'sec-fetch-site': site } })).status).toBe(403);
  });

  it('refuses a cross-site POST that carries no body', async () => {
    const res = await request(`/api/translate/${T}/${C}?target=FR`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses hostnames that do not point at this machine', async () => {
    expect((await request('/api/ping', { headers: { host: 'evil.example:5180' } })).status).toBe(403);
    expect((await request('/api/ping', { headers: { host: 'localhost:5180' } })).status).toBe(200);
  });
});

describe('what the API accepts', () => {
  it.each([
    '/api/library/..',
    '/api/library/%2E%2E',
    `/api/translate/..%2F..%2Fx/${C}/1/overlay?target=FR`,
    `/api/translate/${T}/${C}/abc/overlay?target=FR`,
    `/api/translate/${T}/${C}/0/overlay?target=FR`,
  ])('refuses %s', async (pathname) => {
    expect((await request(pathname)).status).toBe(400);
  });

  it('still routes the job status path', async () => {
    const res = await request(`/api/translate/${T}/${C}/status?target=FR`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ known: false });
  });

  it('refuses ids in request bodies that could climb out of the library', async () => {
    expect((await request('/api/library/import', { method: 'POST', json: { id: '../x' } })).status).toBe(400);
    expect(
      (await request('/api/progress', { method: 'POST', json: { titleId: '..', chapterId: '..' } })).status,
    ).toBe(400);
  });

  it('stores corrections and lists the words they taught', async () => {
    const bad = await request('/api/corrections', {
      method: 'POST',
      json: { sourceLang: 'vi; drop', source: 'a', corrected: 'b' },
    });
    expect(bad.status).toBe(400);

    const ok = await request('/api/corrections', {
      method: 'POST',
      json: { sourceLang: 'vi', source: 'LÄ @IÚP', corrected: 'LÀ GIÚP' },
    });
    expect(ok.status).toBe(200);
    const list = JSON.parse((await request('/api/corrections?lang=vi')).body);
    expect(list.corrections).toHaveLength(1);
    expect(list.words.map((w: { source: string }) => w.source)).toEqual(['@iúp']);
  });
});
