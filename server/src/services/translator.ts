import { config } from '../config';
import { isSameLanguage, langSpec } from './lang';

const freeUrl = 'https://api-free.deepl.com';
const proUrl = 'https://api.deepl.com';

export type Provider = 'claude' | 'deepl' | 'google' | 'none';

export interface TranslationResult {
  provider: Provider;
  /** 1:1 with the input array. */
  texts: string[];
}

function deeplBaseUrl(): string {
  const url = config.translate.deeplUrl;
  if (url) return url;
  const key = config.translate.deeplApiKey ?? '';
  return key.endsWith(':fx') ? freeUrl : proUrl;
}

/** Memo across pages: repeated SFX and stock phrases are translated once. */
const memo = new Map<string, string>();

function memoKey(target: string, text: string): string {
  return `${target}\u0000${text}`;
}

// ---------------------------------------------------------------------------
// Claude — context-aware, whole page in one call
// ---------------------------------------------------------------------------

let anthropicClient: unknown | null = null;

export function isLlmConfigured(): boolean {
  return config.translate.llm.enabled && Boolean(config.translate.llm.apiKey);
}

/**
 * Translates every bubble of a page in a single request so the model can use
 * neighbouring bubbles as context. This is what fixes pronouns, sentence flow
 * and manga register — a per-bubble MT call cannot see any of that.
 */
async function claudeTranslate(
  texts: string[],
  targetLang: string,
  sourceLabel: string,
): Promise<string[] | null> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  const { z } = await import('zod');

  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.translate.llm.apiKey });
  }
  const client = anthropicClient as InstanceType<typeof Anthropic>;

  const schema = z.object({
    translations: z.array(
      z.object({
        id: z.number(),
        text: z.string(),
      }),
    ),
  });

  const numbered = texts.map((t, i) => `${i}\t${t}`).join('\n');
  const targetName = langSpec(targetLang.toLowerCase()).label;

  const response = await client.messages.parse({
    model: config.translate.llm.model,
    max_tokens: 8000,
    output_config: {
      effort: config.translate.llm.effort,
      format: zodOutputFormat(schema),
    },
    system:
      'You translate comic and manga speech bubbles. You receive every text ' +
      'block of one page, in reading order, as `id<TAB>text` lines. Return one ' +
      'translation per input id, keeping the same ids.\n' +
      '- The source text comes from OCR and may contain recognition errors; ' +
      'infer the intended wording from the surrounding blocks.\n' +
      '- Use the other blocks as context so pronouns, honorifics and register ' +
      'stay consistent across the page.\n' +
      '- Keep it as short as the original: it has to fit back inside the same ' +
      'speech bubble.\n' +
      '- Keep sound effects as sound effects.\n' +
      '- Never merge or split blocks, never add commentary, never leave a ' +
      'block empty. If a block is unreadable, repeat it unchanged.',
    messages: [
      {
        role: 'user',
        content: `Source language: ${sourceLabel}. Target language: ${targetName}.\n\n${numbered}`,
      },
    ],
  });

  const parsed = response.parsed_output;
  if (!parsed) return null;

  const out = [...texts];
  let filled = 0;
  for (const item of parsed.translations) {
    if (!Number.isInteger(item.id) || item.id < 0 || item.id >= texts.length) continue;
    const text = item.text.trim();
    if (!text) continue;
    out[item.id] = text;
    filled++;
  }
  // A reply that covered almost nothing is more likely broken than correct.
  if (filled < Math.ceil(texts.length / 2)) return null;
  return out;
}

// ---------------------------------------------------------------------------
// DeepL
// ---------------------------------------------------------------------------

async function deeplTranslate(
  texts: string[],
  targetLang: string,
  sourceCode: string | null,
): Promise<string[]> {
  const key = config.translate.deeplApiKey;
  const url = `${deeplBaseUrl()}/v2/translate`;
  const out: string[] = [];

  for (let i = 0; i < texts.length; i += 25) {
    const body = texts.slice(i, i + 25);
    const payload: Record<string, unknown> = { text: body, target_lang: targetLang };
    if (sourceCode) payload.source_lang = sourceCode;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`DeepL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const json = (await res.json()) as { translations?: { text?: string }[] };
    out.push(...(json.translations ?? []).map((t) => t.text ?? ''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google (free endpoint) — last resort
// ---------------------------------------------------------------------------

/** Pulls plain strings out of the endpoint's two response shapes. */
function parseGoogleBody(json: unknown, expected: number): string[] | null {
  if (!Array.isArray(json)) return null;
  const out = json.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
    return '';
  });
  return out.length === expected ? out : null;
}

async function googleTranslate(
  texts: string[],
  targetLang: string,
  sourceCode: string | null,
): Promise<string[]> {
  const tl = deeplToGoogleLang(targetLang);
  const sl = sourceCode ?? 'auto';
  const out: string[] = [];

  // One `q` parameter per block: the old newline-joining scheme silently
  // mis-aligned results whenever the engine merged or split a line.
  for (let i = 0; i < texts.length; ) {
    const chunk: string[] = [];
    let length = 0;
    while (i < texts.length && chunk.length < 20) {
      const encoded = encodeURIComponent(texts[i]).length + 3;
      if (chunk.length > 0 && length + encoded > 1500) break;
      chunk.push(texts[i]);
      length += encoded;
      i++;
    }
    const params = chunk.map((t) => `q=${encodeURIComponent(t)}`).join('&');
    // client=gtx is blocked for non-browser clients (TLS fingerprinting);
    // dict-chrome-ex returns the same data and is not fingerprint-gated.
    const url = `https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&dt=t&${params}`;
    const res = await fetchWithRetryGoogle(url);
    const parsed = parseGoogleBody(await res.json(), chunk.length);
    out.push(...(parsed ?? chunk));
  }
  return out;
}

// Retry on transient 429/5xx from the free endpoint with small backoff.
async function fetchWithRetryGoogle(url: string, retries = 4): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': config.mangadex.userAgent },
    });
    if (res.ok) return res;
    lastErr = new Error(`HTTP ${res.status}`);
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
      continue;
    }
    throw lastErr;
  }
  throw lastErr instanceof Error ? lastErr : new Error('google translate failed');
}

function deeplToGoogleLang(target: string): string {
  switch (target) {
    case 'ZH-HANS':
      return 'zh-CN';
    case 'ZH-HANT':
      return 'zh-TW';
    case 'PT-BR':
      return 'pt';
    case 'PT-PT':
      return 'pt-PT';
    default:
      return target.toLowerCase();
  }
}

// ---------------------------------------------------------------------------

/**
 * Translates whole text blocks (one speech bubble each), preserving order and
 * arity. Providers are tried best-first: Claude when a key is configured, then
 * DeepL, then the free Google endpoint.
 */
export async function translateBlocks(
  texts: string[],
  targetLang: string,
  sourceLang: string,
): Promise<TranslationResult> {
  if (texts.length === 0) return { provider: 'none', texts: [] };
  if (isSameLanguage(sourceLang, targetLang)) return { provider: 'none', texts: [...texts] };

  const output = [...texts];
  const pending: string[] = [];
  const pendingIdx: number[] = [];
  texts.forEach((text, i) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const hit = memo.get(memoKey(targetLang, trimmed));
    if (hit !== undefined) output[i] = hit;
    else {
      pending.push(trimmed);
      pendingIdx.push(i);
    }
  });
  if (pending.length === 0) return { provider: 'none', texts: output };

  const spec = langSpec(sourceLang);
  let provider: Provider = 'google';
  let results: string[] | null = null;

  if (isLlmConfigured()) {
    try {
      results = await claudeTranslate(pending, targetLang, spec.label);
      if (results) provider = 'claude';
      else console.warn('[translate] Claude returned an unusable reply; falling back');
    } catch (err) {
      console.error(
        `[translate] Claude failed: ${err instanceof Error ? err.message : err}; falling back`,
      );
    }
  }

  if (!results && config.translate.deeplApiKey) {
    try {
      results = await deeplTranslate(pending, targetLang, spec.deepl);
      if (results.length !== pending.length) {
        console.warn('[translate] DeepL returned a mismatched count; falling back to Google');
        results = null;
      } else {
        provider = 'deepl';
      }
    } catch (err) {
      console.error(
        `[translate] DeepL failed: ${err instanceof Error ? err.message : err}; using Google fallback`,
      );
    }
  }

  if (!results) {
    // DeepL source codes are the ISO-639-1 base, which Google accepts too.
    results = await googleTranslate(pending, targetLang, spec.deepl ? spec.deepl.toLowerCase() : null);
    provider = 'google';
  }

  results.forEach((text, i) => {
    const clean = (text ?? '').trim();
    if (!clean) return;
    output[pendingIdx[i]] = clean;
    memo.set(memoKey(targetLang, pending[i]), clean);
  });

  return { provider, texts: output };
}
