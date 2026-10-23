import { describe, expect, it } from 'vitest';
import { groupIntoBlocks, type OcrLine } from '../src/services/textBlocks';

const page = { width: 6000, height: 3000 };

/** A one-line box, far from every other so nothing clusters by accident. */
function alone(text: string, i: number): OcrLine {
  return { text, conf: 90, x0: 100 + i * 400, y0: 100, x1: 220 + i * 400, y1: 140 };
}

function texts(lines: OcrLine[], script: 'jpn' | 'cjk' | 'latin'): string[] {
  return groupIntoBlocks(lines, { script, ...page })
    .map((b) => b.text)
    .sort();
}

describe('groupIntoBlocks', () => {
  it('keeps one- and two-glyph Japanese reactions', () => {
    const kept = texts(['うん', 'え？', '何!?', '嘘', 'よし'].map(alone), 'jpn');
    expect(kept).toEqual(['うん', 'え?', 'よし', '何!?', '嘘'].sort());
  });

  it('keeps short Korean replies', () => {
    expect(texts(['응', '뭐?'].map(alone), 'cjk')).toEqual(['뭐?', '응'].sort());
  });

  it('still drops marks that never make a bubble on their own', () => {
    expect(texts(['ー', 'ッ', '。', '…', '!?'].map(alone), 'jpn')).toEqual([]);
  });

  it('keeps two-letter Latin bubbles but not single letters or debris', () => {
    expect(texts(['NO', 'OK', 'I', '(I"', 'ძ.'].map(alone), 'latin')).toEqual(['NO', 'OK']);
  });

  it('joins the lines of one bubble in reading order', () => {
    const lines: OcrLine[] = [
      { text: 'LEGENDARY HERO!', conf: 90, x0: 100, y0: 172, x1: 330, y1: 202 },
      { text: 'A MAN THAT IS', conf: 90, x0: 110, y0: 100, x1: 320, y1: 130 },
      { text: 'CAPARABLE TO THE', conf: 90, x0: 95, y0: 136, x1: 335, y1: 166 },
    ];
    const blocks = groupIntoBlocks(lines, { script: 'latin', ...page });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('A MAN THAT IS CAPARABLE TO THE LEGENDARY HERO!');
  });

  it('rejoins a word hyphenated across two lines', () => {
    const lines: OcrLine[] = [
      { text: 'UNNATU-', conf: 90, x0: 100, y0: 100, x1: 220, y1: 130 },
      { text: 'RAL THING', conf: 90, x0: 100, y0: 136, x1: 240, y1: 166 },
    ];
    expect(groupIntoBlocks(lines, { script: 'latin', ...page })[0].text).toBe('UNNATURAL THING');
  });

  it('reads vertical Japanese columns right to left', () => {
    const lines: OcrLine[] = [
      { text: 'みんな', conf: 100, x0: 260, y0: 100, x1: 290, y1: 220 },
      { text: 'いくぞ', conf: 100, x0: 300, y0: 100, x1: 330, y1: 220 },
    ];
    const [block] = groupIntoBlocks(lines, { script: 'jpn', ...page });
    expect(block.vertical).toBe(true);
    expect(block.text).toBe('いくぞみんな');
  });

  it('folds the fullwidth Latin manga-ocr reports', () => {
    expect(texts([alone('ＯＫ！', 0)], 'jpn')).toEqual(['OK!']);
  });

  it('drops lines below the confidence floor', () => {
    const lines = [alone('KEEP THIS', 0), { ...alone('DROP THIS', 1), conf: 20 }];
    expect(groupIntoBlocks(lines, { script: 'latin', minConfidence: 55, ...page }).map((b) => b.text)).toEqual([
      'KEEP THIS',
    ]);
  });
});
