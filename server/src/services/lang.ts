/**
 * Language plumbing for the translation pipeline.
 *
 * Three code spaces meet here:
 *  - MangaDex chapter codes (`ja`, `pt-br`, `zh-hk`, `ka`, …) — what is actually
 *    printed on the page we are about to OCR;
 *  - tesseract traineddata names (`jpn`, `por`, `chi_tra`, `kat`, …);
 *  - DeepL codes (`JA`, `PT-BR`, `ZH-HANS`, …) — the reader's target language.
 *
 * The old pipeline conflated the *title*'s original language with the
 * *chapter*'s language and then let `TRANSLATE_SRC` override both, so Japanese
 * OCR ran on Georgian and English scans. Everything now routes through here.
 */

/** Coarse writing-system class; drives OCR engine choice, wrapping and fonts. */
export type Script = 'jpn' | 'cjk' | 'latin' | 'cyrillic' | 'other';

export interface LangSpec {
  /** MangaDex-style code, normalized to lowercase. */
  code: string;
  /** tesseract traineddata name. */
  tesseract: string;
  /** DeepL source code, or null when DeepL cannot take it as a source. */
  deepl: string | null;
  script: Script;
  label: string;
  /** Right-to-left script (Hebrew, Arabic, …). */
  rtl: boolean;
}

const UNKNOWN: LangSpec = {
  code: 'en',
  tesseract: 'eng',
  deepl: 'EN',
  script: 'latin',
  label: 'English',
  rtl: false,
};

/** [tesseract, deepl, script, label, rtl?] keyed by MangaDex language code. */
const TABLE: Record<string, [string, string | null, Script, string, boolean?]> = {
  ja: ['jpn', 'JA', 'jpn', 'Japanese'],
  'ja-ro': ['eng', 'EN', 'latin', 'Japanese (romanized)'],
  ko: ['kor', 'KO', 'cjk', 'Korean'],
  'ko-ro': ['eng', 'EN', 'latin', 'Korean (romanized)'],
  zh: ['chi_sim', 'ZH', 'cjk', 'Chinese (Simplified)'],
  'zh-hans': ['chi_sim', 'ZH', 'cjk', 'Chinese (Simplified)'],
  'zh-hk': ['chi_tra', 'ZH', 'cjk', 'Chinese (Traditional)'],
  'zh-hant': ['chi_tra', 'ZH', 'cjk', 'Chinese (Traditional)'],
  'zh-ro': ['eng', 'EN', 'latin', 'Chinese (romanized)'],
  en: ['eng', 'EN', 'latin', 'English'],
  fr: ['fra', 'FR', 'latin', 'French'],
  de: ['deu', 'DE', 'latin', 'German'],
  es: ['spa', 'ES', 'latin', 'Spanish'],
  'es-la': ['spa', 'ES', 'latin', 'Spanish (Latin America)'],
  pt: ['por', 'PT', 'latin', 'Portuguese'],
  'pt-br': ['por', 'PT', 'latin', 'Portuguese (Brazil)'],
  it: ['ita', 'IT', 'latin', 'Italian'],
  nl: ['nld', 'NL', 'latin', 'Dutch'],
  pl: ['pol', 'PL', 'latin', 'Polish'],
  ru: ['rus', 'RU', 'cyrillic', 'Russian'],
  uk: ['ukr', 'UK', 'cyrillic', 'Ukrainian'],
  bg: ['bul', 'BG', 'cyrillic', 'Bulgarian'],
  tr: ['tur', 'TR', 'latin', 'Turkish'],
  id: ['ind', 'ID', 'latin', 'Indonesian'],
  ms: ['msa', null, 'latin', 'Malay'],
  vi: ['vie', null, 'latin', 'Vietnamese'],
  th: ['tha', null, 'other', 'Thai'],
  ar: ['ara', 'AR', 'other', 'Arabic', true],
  he: ['heb', 'HE', 'other', 'Hebrew', true],
  fa: ['fas', null, 'other', 'Persian', true],
  ka: ['kat', null, 'other', 'Georgian'],
  hi: ['hin', null, 'other', 'Hindi'],
  bn: ['ben', null, 'other', 'Bengali'],
  ta: ['tam', null, 'other', 'Tamil'],
  cs: ['ces', 'CS', 'latin', 'Czech'],
  sk: ['slk', 'SK', 'latin', 'Slovak'],
  sl: ['slv', 'SL', 'latin', 'Slovenian'],
  hu: ['hun', 'HU', 'latin', 'Hungarian'],
  ro: ['ron', 'RO', 'latin', 'Romanian'],
  el: ['ell', 'EL', 'other', 'Greek'],
  sv: ['swe', 'SV', 'latin', 'Swedish'],
  da: ['dan', 'DA', 'latin', 'Danish'],
  fi: ['fin', 'FI', 'latin', 'Finnish'],
  no: ['nor', 'NB', 'latin', 'Norwegian'],
  nb: ['nor', 'NB', 'latin', 'Norwegian Bokmål'],
  lt: ['lit', 'LT', 'latin', 'Lithuanian'],
  lv: ['lav', 'LV', 'latin', 'Latvian'],
  et: ['est', 'ET', 'latin', 'Estonian'],
  ca: ['cat', null, 'latin', 'Catalan'],
  eo: ['epo', null, 'latin', 'Esperanto'],
  fil: ['fil', null, 'latin', 'Filipino'],
  hr: ['hrv', null, 'latin', 'Croatian'],
  sr: ['srp', null, 'cyrillic', 'Serbian'],
};

/** Resolves a MangaDex chapter language code to its OCR/translation spec. */
export function langSpec(code: string | null | undefined): LangSpec {
  const key = (code ?? '').trim().toLowerCase();
  const row = TABLE[key] ?? TABLE[key.split('-')[0]];
  if (!row) return { ...UNKNOWN, code: key || UNKNOWN.code };
  const [tesseract, deepl, script, label, rtl] = row;
  return { code: key, tesseract, deepl, script, label, rtl: rtl === true };
}

/** DeepL target code -> the MangaDex-style code for the same language. */
export function targetToCode(target: string): string {
  const t = (target ?? '').toUpperCase();
  switch (t) {
    case 'ZH-HANS':
      return 'zh';
    case 'ZH-HANT':
      return 'zh-hant';
    case 'PT-BR':
      return 'pt-br';
    case 'PT-PT':
      return 'pt';
    case 'EN-GB':
    case 'EN-US':
      return 'en';
    default:
      return t.toLowerCase();
  }
}

/**
 * True when translating would be a no-op: an English chapter asked for `EN`
 * gets served untouched instead of being round-tripped through OCR.
 */
export function isSameLanguage(chapterCode: string | null | undefined, target: string): boolean {
  const src = langSpec(chapterCode);
  const dst = langSpec(targetToCode(target));
  if (!src.code || !dst.code) return false;
  // Regional variants of the same language count as identical (pt vs pt-br).
  return src.code.split('-')[0] === dst.code.split('-')[0];
}

/** Writing system of a DeepL target code — picks the render font and wrapping. */
export function targetScript(target: string): Script {
  return langSpec(targetToCode(target)).script;
}

/** Scripts whose text wraps between any two characters rather than on spaces. */
export function wrapsAnywhere(script: Script): boolean {
  return script === 'jpn' || script === 'cjk';
}
