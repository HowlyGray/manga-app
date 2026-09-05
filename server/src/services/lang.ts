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

/**
 * How well the OCR + translation chain handles a language, 0 being best.
 *
 * This is a property of *our* pipeline, not of the language: English wins
 * because both tesseract and every MT engine are strongest there, Japanese
 * ranks above Korean and Chinese because manga-ocr is purpose-built for it,
 * and scripts with weak traineddata come last however common they are.
 */
export function pipelineRank(code: string | null | undefined): number {
  const spec = langSpec(code);
  if (spec.code === 'en') return 0;
  switch (spec.script) {
    case 'latin':
      // A DeepL source code is a good proxy for "well-supported everywhere";
      // without one the OCR is still easy but the translation is Google-only.
      return spec.deepl ? 1 : 3;
    case 'jpn':
      // manga-ocr is purpose-built for this and beats tesseract on any script.
      return 2;
    case 'cyrillic':
      return 4;
    case 'cjk':
      return 5;
    default:
      return 6;
  }
}

/**
 * Builds a comparator key over chapter languages: entries in `preferred` win in
 * the order given, everything else falls back to how well the pipeline reads it.
 */
export function languageRanker(preferred: string[]): (code: string | null | undefined) => number {
  const explicit = new Map(preferred.map((c, i) => [c.trim().toLowerCase(), i]));
  return (code) => {
    const key = (code ?? '').trim().toLowerCase();
    const hit = explicit.get(key) ?? explicit.get(key.split('-')[0]);
    return hit !== undefined ? hit : preferred.length + pipelineRank(key);
  };
}

/**
 * Symbols OCR emits that are never part of a word in any script we handle.
 *
 * Measured on a Vietnamese chapter: `@` alone appeared 21 times, every one of
 * them a misread `G` ("@IÚP" for "GIÚP"). Letters that merely look foreign are
 * deliberately not here — `Ä` and `Ï` are wrong in Vietnamese but perfectly
 * ordinary in German or French, and a language-blind list would flag those.
 */
const NON_LETTERS = /[@&\|~^⁄¤©°§±¶µ]/;

/** True when a reading contains a character that cannot belong to a word. */
export function hasImpossibleCharacters(text: string): boolean {
  return NON_LETTERS.test(text);
}
