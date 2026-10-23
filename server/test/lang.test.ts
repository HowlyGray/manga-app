import { describe, expect, it } from 'vitest';
import {
  hasImpossibleCharacters,
  isSameLanguage,
  langSpec,
  languageRanker,
  targetScript,
  wrapsAnywhere,
} from '../src/services/lang';

describe('langSpec', () => {
  it('maps chapter languages to OCR and translation codes', () => {
    expect(langSpec('pt-br')).toMatchObject({ tesseract: 'por', deepl: 'PT', script: 'latin' });
    expect(langSpec('ja')).toMatchObject({ tesseract: 'jpn', script: 'jpn' });
    expect(langSpec('zh-hk')).toMatchObject({ tesseract: 'chi_tra', script: 'cjk' });
    expect(langSpec('he')).toMatchObject({ tesseract: 'heb', rtl: true });
  });

  it('falls back to English OCR for unknown codes but keeps the code', () => {
    expect(langSpec('xx')).toMatchObject({ code: 'xx', tesseract: 'eng' });
  });
});

describe('isSameLanguage', () => {
  it('treats regional variants as the same language', () => {
    expect(isSameLanguage('en', 'EN')).toBe(true);
    expect(isSameLanguage('pt-br', 'PT-BR')).toBe(true);
    expect(isSameLanguage('ja', 'EN')).toBe(false);
  });
});

describe('languageRanker', () => {
  it('puts explicit preferences first, then what the pipeline reads best', () => {
    const rank = languageRanker(['pt-br', 'es']);
    const order = ['ka', 'en', 'es', 'ja', 'pt-br'].sort((a, b) => rank(a) - rank(b));
    expect(order).toEqual(['pt-br', 'es', 'en', 'ja', 'ka']);
  });
});

describe('scripts', () => {
  it('wraps CJK targets anywhere and Latin on spaces', () => {
    expect(wrapsAnywhere(targetScript('JA'))).toBe(true);
    expect(wrapsAnywhere(targetScript('FR'))).toBe(false);
  });

  it('flags characters no word contains', () => {
    expect(hasImpossibleCharacters('@IÚP')).toBe(true);
    expect(hasImpossibleCharacters('GIÚP')).toBe(false);
  });
});
