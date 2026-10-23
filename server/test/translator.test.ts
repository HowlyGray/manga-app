import { afterEach, describe, expect, it, vi } from 'vitest';
import { translateBlocks } from '../src/services/translator';

/** Stands in for Google's free endpoint and records what was sent to it. */
function stubGoogle() {
  const sent: string[][] = [];
  const guard = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://translate.googleapis.com/')) return guard(input, init);
    const q = new URL(url).searchParams.getAll('q');
    sent.push(q);
    return new Response(JSON.stringify(q.map((t) => [`[FR] ${t}`])), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('translateBlocks', () => {
  it('sends nothing when every bubble already has a translation', async () => {
    // The setup's fetch guard would reject any request.
    const out = await translateBlocks(['HELLO', 'WORLD'], 'FR', 'en', ['BONJOUR', 'MONDE']);
    expect(out).toEqual({ provider: 'none', texts: ['BONJOUR', 'MONDE'] });
  });

  it('translates only the bubbles without one', async () => {
    const sent = stubGoogle();
    const out = await translateBlocks(['KEEP ME', 'NEW TEXT', ''], 'FR', 'en', ['GARDE-MOI']);
    expect(sent).toEqual([['NEW TEXT']]);
    expect(out.texts).toEqual(['GARDE-MOI', '[FR] NEW TEXT', '']);
    expect(out.provider).toBe('google');
  });

  it('remembers translations across pages', async () => {
    const sent = stubGoogle();
    await translateBlocks(['SAME PHRASE'], 'FR', 'en');
    await translateBlocks(['SAME PHRASE'], 'FR', 'en');
    expect(sent.flat()).toEqual(['SAME PHRASE']);
  });

  it('does not translate a page already in the target language', async () => {
    expect(await translateBlocks(['HELLO'], 'EN', 'en')).toEqual({ provider: 'none', texts: ['HELLO'] });
  });
});
