/**
 * The Claude path, with the SDK mocked: no key, no request. Config is read at
 * import time, so the provider is switched on before the module is loaded.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { parse };
  },
}));

let translateBlocks: typeof import('../src/services/translator').translateBlocks;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.TRANSLATE_LLM = '1';
  ({ translateBlocks } = await import('../src/services/translator'));
});

/** The id/text lines the model was given in its most recent request. */
function sentLines(): string[] {
  const request = parse.mock.calls.at(-1)![0] as { messages: { content: string }[] };
  return request.messages[0].content.split('\n\n')[1].split('\n');
}

describe('Claude translation', () => {
  it('sends the whole page, with already-translated bubbles as context only', async () => {
    parse.mockResolvedValueOnce({
      parsed_output: {
        translations: [
          { id: 0, text: 'BONJOUR' },
          { id: 2, text: 'ENCORE' },
          // Ids it was not asked for are ignored.
          { id: 1, text: 'SHOULD NOT WIN' },
        ],
      },
    });
    const out = await translateBlocks(['HELLO', 'WORLD', 'AGAIN'], 'FR', 'en', [undefined, 'MONDE']);
    expect(sentLines()).toEqual(['0\tHELLO', '1\tWORLD\tMONDE', '2\tAGAIN']);
    expect(out).toEqual({ provider: 'claude', texts: ['BONJOUR', 'MONDE', 'ENCORE'] });
  });

  it('does not memoize a bubble the reply skipped', async () => {
    parse.mockResolvedValueOnce({
      parsed_output: { translations: [{ id: 0, text: 'UN' }] },
    });
    const first = await translateBlocks(['ONE', 'TWO'], 'FR', 'en');
    expect(first.texts).toEqual(['UN', 'TWO']);

    parse.mockResolvedValueOnce({
      parsed_output: { translations: [{ id: 1, text: 'DEUX' }] },
    });
    const second = await translateBlocks(['ONE', 'TWO'], 'FR', 'en');
    // ONE comes from the memo (as context); TWO is asked for again.
    expect(sentLines()).toEqual(['0\tONE\tUN', '1\tTWO']);
    expect(second.texts).toEqual(['UN', 'DEUX']);
  });
});
