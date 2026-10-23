import { describe, expect, it } from 'vitest';
import {
  applyCorrections,
  deleteCorrection,
  listCorrections,
  listWordCorrections,
  saveCorrection,
} from '../src/services/corrections';

// Every test uses its own source language: they share one database.
const words = (lang: string) => listWordCorrections(lang).map((w) => `${w.source}->${w.corrected}`);

describe('corrections', () => {
  it('replaces a whole bubble that reads the same again', () => {
    saveCorrection('vi', 'LÄ @IÚP', 'LÀ GIÚP');
    expect(applyCorrections('vi', ['LÄ @IÚP', 'KHÔNG'])).toEqual(['LÀ GIÚP', 'KHÔNG']);
    expect(listCorrections('vi')[0]).toMatchObject({ source: 'lä @iúp', corrected: 'LÀ GIÚP' });
  });

  it('takes a re-edit keyed by the raw reading', () => {
    saveCorrection('pt', 'OLA MUMDO', 'OLÁ MUNDO');
    // The reader sends the block's raw `reading` again, not the corrected text.
    saveCorrection('pt', 'OLA MUMDO', 'OLÁ, MUNDO!');
    expect(applyCorrections('pt', ['OLA MUMDO'])).toEqual(['OLÁ, MUNDO!']);
  });

  it('learns a misread word and fixes it in other bubbles, keeping their case', () => {
    saveCorrection('id', 'TOLONG @IÚP', 'TOLONG GIÚP');
    expect(words('id')).toEqual(['@iúp->GIÚP']);
    expect(applyCorrections('id', ['ANH SẼ @IÚP TÔI!', 'đừng @iúp.'])).toEqual([
      'ANH SẼ GIÚP TÔI!',
      'đừng giúp.',
    ]);
  });

  it('still learns the word when the fix also adds a word', () => {
    saveCorrection('ms', 'LÄ @IÚP', 'LÀ GIÚP ĐỠ');
    expect(words('ms')).toEqual(['@iúp->GIÚP']);
  });

  it('learns digits inside letters, but not letters-only edits or rewordings', () => {
    saveCorrection('en', 'I 0K WITH THEN', 'I OK WITH THEY');
    saveCorrection('en', 'WHAT @&!', 'WHAT COMPLETELY');
    expect(words('en')).toEqual(['0k->OK']);
  });

  it('clearing a fix removes the words it taught', () => {
    saveCorrection('tr', 'BU @IZEL', 'BU GIZEL');
    expect(words('tr')).toHaveLength(1);
    deleteCorrection('tr', 'BU @IZEL');
    expect(words('tr')).toEqual([]);
    expect(applyCorrections('tr', ['BU @IZEL'])).toEqual(['BU @IZEL']);
  });

  it('re-editing a bubble replaces what it taught', () => {
    saveCorrection('fr', 'C3T @MI', 'CET AMI');
    saveCorrection('fr', 'C3T @MI', 'C3T AMI');
    expect(words('fr')).toEqual(['@mi->AMI']);
  });
});
