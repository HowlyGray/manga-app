import { config } from '../config';

const freeUrl = 'https://api-free.deepl.com';
const proUrl = 'https://api.deepl.com';

function deeplBaseUrl(): string {
  const url = config.translate.deeplUrl;
  if (url) return url;
  const key = config.translate.deeplApiKey ?? '';
  return key.endsWith(':fx') ? freeUrl : proUrl;
}

export interface TranslationResult {
  provider: 'deepl' | 'google';
  lines: string[];
}

const lineCache = new Map<string, string>();

async function deeplTranslate(lines: string[], targetLang: string, sourceLang: string): Promise<string[]> {
  const key = config.translate.deeplApiKey;
  const url = `${deeplBaseUrl()}/v2/translate`;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 25) {
    const body = lines.slice(i, i + 25);
    const payload: Record<string, unknown> = { text: body, target_lang: targetLang };
    if (sourceLang) payload.source_lang = sourceLang;

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

async function googleTranslate(lines: string[], targetLang: string): Promise<string[]> {
  const tl = deeplToGoogleLang(targetLang);
  const separator = '\n';
  // Batch all lines into a single request (joined by newlines) to avoid
  // hammering the free endpoint; split the result back on the separator.
  const joined = lines.join(separator);
  // client=gtx is blocked for non-browser clients (TLS fingerprinting);
  // dict-chrome-ex returns the same data and is not fingerprint-gated.
  const url = `https://translate.googleapis.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(joined)}`;
  const res = await fetchWithRetryGoogle(url);
  const json = (await res.json()) as unknown;
  const pairs = json as [string, string][];
  const translated = (pairs[0]?.[0] ?? '').trim();
  const parts = translated.split(separator);
  return lines.map((line, i) => (parts[i]?.trim() ? parts[i]!.trim() : line));
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

/** Translates lines while preserving position/emptiness (1:1 mapping). */
export async function translateLines(
  lines: string[],
  targetLang: string,
  sourceLang?: string,
): Promise<TranslationResult> {
  // Remember where the non-empty lines sit so we can reassemble exactly.
  const positions: number[] = [];
  const need: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    positions.push(i);
    need.push(line);
  }

  const translated = new Array<string>(need.length).fill('');
  const toFetch: string[] = [];
  const fetchIdx: number[] = [];
  need.forEach((line, i) => {
    const hit = lineCache.get(`${targetLang}:${line}`);
    if (hit !== undefined) translated[i] = hit;
    else {
      toFetch.push(line);
      fetchIdx.push(i);
    }
  });

  if (toFetch.length > 0) {
    const src = sourceLang ? deeplSourceCode(sourceLang) : '';
    let provider: 'deepl' | 'google' = 'google';
    let results: string[] | null = null;

    if (config.translate.deeplApiKey) {
      try {
        results = await deeplTranslate(toFetch, targetLang, src);
        provider = 'deepl';
      } catch (err) {
        console.error(`[translate] DeepL failed: ${err instanceof Error ? err.message : err}; using Google fallback`);
      }
    }
    if (!results) results = await googleTranslate(toFetch, targetLang);

    results.forEach((text, i) => {
      translated[fetchIdx[i]] = text;
      if (text) lineCache.set(`${targetLang}:${toFetch[i]}`, text);
    });
  }

  const output = new Array<string>(lines.length).fill('');
  positions.forEach((pos, i) => {
    output[pos] = translated[i] || lines[pos];
  });
  // Keep original empties empty.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) output[i] = '';
  }

  return { provider: config.translate.deeplApiKey ? 'deepl' : 'google', lines: output };
}

function deeplSourceCode(ocrLang: string): string {
  switch (ocrLang) {
    case 'jpn':
      return 'JA';
    case 'kor':
      return 'KO';
    case 'chi_sim':
    case 'chi_tra':
      return 'ZH';
    case 'fra':
      return 'FR';
    case 'deu':
      return 'DE';
    case 'spa':
      return 'ES';
    case 'rus':
      return 'RU';
    default:
      return '';
  }
}

/** Maps a MangaDex-style language code to a source language for OCR. */
export function normalizeOcrSource(lang: string | null | undefined): { ocr: string; label: string } {
  switch ((lang ?? '').toLowerCase()) {
    case 'ja':
      return { ocr: 'jpn', label: 'Japanese' };
    case 'ko':
      return { ocr: 'kor', label: 'Korean' };
    case 'zh':
    case 'zh-hk':
    case 'zh-hans':
      return { ocr: 'chi_sim', label: 'Chinese Simplified' };
    case 'zh-hant':
      return { ocr: 'chi_tra', label: 'Chinese Traditional' };
    case 'fr':
      return { ocr: 'fra', label: 'French' };
    case 'de':
      return { ocr: 'deu', label: 'German' };
    case 'es':
      return { ocr: 'spa', label: 'Spanish' };
    case 'ru':
      return { ocr: 'rus', label: 'Russian' };
    case 'pt':
    case 'pt-br':
      return { ocr: 'por', label: 'Portuguese' };
    default:
      return { ocr: 'eng', label: 'English' };
  }
}