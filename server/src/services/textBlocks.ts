/**
 * Groups per-line OCR boxes into speech-bubble sized text blocks.
 *
 * Both OCR engines return one box per *line*, not per bubble. Translating those
 * lines individually is what turned "A MAN THAT IS CAPARABLE TO THE LEGENDARY
 * HERO HAS APPEARED!" into six disconnected fragments. Clustering the lines and
 * sending the bubble as a single string is the largest quality win in the
 * pipeline, so the joining rules below are deliberately conservative: merging
 * two unrelated bubbles is worse than leaving one bubble split.
 */
import type { Script } from './lang';

export interface OcrLine {
  text: string;
  conf: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextBlock {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  lines: OcrLine[];
  /** Source text, lines joined in reading order. */
  text: string;
  /** Source ran as vertical columns (Japanese tategaki). */
  vertical: boolean;
  /** Mean OCR confidence over the block's lines, 0-100. */
  conf: number;
}

type Orientation = 'vertical' | 'horizontal' | 'neutral';

function orientationOf(l: OcrLine): Orientation {
  const w = l.x1 - l.x0;
  const h = l.y1 - l.y0;
  if (h >= w * 1.5) return 'vertical';
  if (w >= h * 1.5) return 'horizontal';
  return 'neutral';
}

/** Overlap of two 1-D spans as a fraction of the shorter span. */
function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const shorter = Math.min(a1 - a0, b1 - b0);
  if (shorter <= 0) return 0;
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / shorter;
}

/** Text that carries no letter, digit or CJK glyph is OCR noise. */
function hasMeaning(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Fullwidth forms are how manga-ocr reports Latin text; fold them for output.
 * Bars and underscores are almost always bubble outlines mistaken for glyphs.
 */
function cleanText(text: string): string {
  return text
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[|_~^\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rejects the debris a permissive detector leaves behind: lone punctuation,
 * single stray glyphs, and short runs that are mostly symbols (`ძ.`, `(I"`).
 * Sending those to a translator wastes a call and paints noise on the page.
 */
function isWorthTranslating(text: string): boolean {
  if (text.length < 3 || !hasMeaning(text)) return false;
  const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return text.length >= 6 || letters / text.length >= 0.5;
}

export interface GroupOptions {
  script: Script;
  /** Right-to-left source (Hebrew, Arabic): reverses horizontal ordering. */
  rtl?: boolean;
  /** Minimum OCR confidence to keep a line, 0-100. */
  minConfidence?: number;
  /** Page dimensions, used to drop boxes that span the whole sheet. */
  width: number;
  height: number;
}

/** Removes empty, degenerate, low-confidence and page-spanning boxes. */
function usableLines(lines: OcrLine[], opts: GroupOptions): OcrLine[] {
  const minConf = opts.minConfidence ?? 0;
  const pageArea = Math.max(1, opts.width * opts.height);
  return lines.filter((l) => {
    const text = cleanText(l.text).trim();
    if (!text || !hasMeaning(text)) return false;
    if (l.conf < minConf) return false;
    const w = l.x1 - l.x0;
    const h = l.y1 - l.y0;
    if (w <= 1 || h <= 1) return false;
    // A box covering most of the sheet is a detection failure, not a bubble.
    if ((w * h) / pageArea > 0.6) return false;
    return true;
  });
}

class UnionFind {
  private parent: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }

  find(i: number): number {
    let node = i;
    while (this.parent[node] !== node) {
      this.parent[node] = this.parent[this.parent[node]];
      node = this.parent[node];
    }
    return node;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** True when two boxes read as consecutive lines of the same bubble. */
function adjacent(a: OcrLine, b: OcrLine): boolean {
  const aw = a.x1 - a.x0;
  const ah = a.y1 - a.y0;
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;

  const oa = orientationOf(a);
  const ob = orientationOf(b);
  // Mixed orientations are separate bubbles (dialogue next to vertical SFX).
  if (oa !== 'neutral' && ob !== 'neutral' && oa !== ob) return false;
  const vertical = oa === 'vertical' || ob === 'vertical';

  if (vertical) {
    // Columns sit side by side: they share a y-range and are close in x.
    if (overlapRatio(a.y0, a.y1, b.y0, b.y1) < 0.3) return false;
    if (Math.max(aw, bw) > Math.min(aw, bw) * 2.4) return false;
    const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
    return gap <= ((aw + bw) / 2) * 1.1;
  }

  if (Math.max(ah, bh) > Math.min(ah, bh) * 2.4) return false;
  const meanH = (ah + bh) / 2;

  // Same baseline, side by side: two words of one line. Detectors sometimes
  // split a line into segments, and the whole-page tesseract fallback returns
  // words rather than lines, so both need re-joining.
  if (overlapRatio(a.y0, a.y1, b.y0, b.y1) >= 0.5) {
    const xGap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
    if (xGap <= meanH * 0.8) return true;
  }

  // Rows stack vertically: they share an x-range and are close in y.
  if (overlapRatio(a.x0, a.x1, b.x0, b.x1) < 0.3) return false;
  const gap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
  return gap <= meanH * 0.9;
}

/** Sorts a cluster's lines into the order a reader would follow. */
function readingOrder(lines: OcrLine[], vertical: boolean, rtl: boolean): OcrLine[] {
  const sorted = [...lines];
  if (vertical) {
    // Japanese tategaki: columns run right to left, glyphs top to bottom.
    sorted.sort((a, b) => {
      const dx = (b.x0 + b.x1) / 2 - (a.x0 + a.x1) / 2;
      if (Math.abs(dx) > 4) return dx;
      return a.y0 - b.y0;
    });
    return sorted;
  }
  sorted.sort((a, b) => {
    const dy = (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2;
    if (Math.abs(dy) > 4) return dy;
    return rtl ? b.x0 - a.x0 : a.x0 - b.x0;
  });
  return sorted;
}

const CJK = /[　-ヿ㐀-鿿豈-﫿ｦ-ﾟ가-힯]/;

/** Joins ordered lines, honouring CJK's lack of spaces and Latin hyphenation. */
function joinLines(lines: OcrLine[], script: Script): string {
  const parts = lines.map((l) => cleanText(l.text).trim()).filter(Boolean);
  if (parts.length === 0) return '';

  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const next = parts[i];
    if (/[\p{L}]-$/u.test(out)) {
      // "unnatu-" + "ral" is one word split across two lines.
      out = out.slice(0, -1) + next;
      continue;
    }
    // CJK runs together, but a Japanese page can still carry Latin lettering
    // (manga-ocr reports it as fullwidth), and that must keep its spaces.
    const tight =
      (script === 'jpn' || script === 'cjk') && CJK.test(out.slice(-1)) && CJK.test(next.slice(0, 1));
    out += tight ? next : ` ${next}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Clusters OCR lines into blocks and returns them in page reading order
 * (top-to-bottom, then right-to-left when the page uses vertical columns).
 */
export function groupIntoBlocks(lines: OcrLine[], opts: GroupOptions): TextBlock[] {
  const usable = usableLines(lines, opts);
  if (usable.length === 0) return [];

  const uf = new UnionFind(usable.length);
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      if (adjacent(usable[i], usable[j])) uf.union(i, j);
    }
  }

  const clusters = new Map<number, OcrLine[]>();
  usable.forEach((line, i) => {
    const root = uf.find(i);
    const bucket = clusters.get(root);
    if (bucket) bucket.push(line);
    else clusters.set(root, [line]);
  });

  const blocks: TextBlock[] = [];
  for (const cluster of clusters.values()) {
    const verticalVotes = cluster.filter((l) => orientationOf(l) === 'vertical').length;
    const horizontalVotes = cluster.filter((l) => orientationOf(l) === 'horizontal').length;
    const vertical = verticalVotes > horizontalVotes;

    const ordered = readingOrder(cluster, vertical, opts.rtl === true);
    const text = joinLines(ordered, opts.script);
    if (!isWorthTranslating(text)) continue;

    blocks.push({
      x0: Math.min(...cluster.map((l) => l.x0)),
      y0: Math.min(...cluster.map((l) => l.y0)),
      x1: Math.max(...cluster.map((l) => l.x1)),
      y1: Math.max(...cluster.map((l) => l.y1)),
      lines: ordered,
      text,
      vertical,
      conf: cluster.reduce((sum, l) => sum + l.conf, 0) / cluster.length,
    });
  }

  const pageIsVertical = blocks.some((b) => b.vertical);
  // Panels flow top-down; vertical scripts read right-to-left within a row.
  blocks.sort((a, b) => {
    const dy = a.y0 - b.y0;
    if (Math.abs(dy) > 24) return dy;
    return pageIsVertical ? b.x0 - a.x0 : a.x0 - b.x0;
  });
  return blocks;
}
