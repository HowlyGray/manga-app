/**
 * Readings the user has corrected by hand.
 *
 * OCR misreads the same lettering the same way across a whole series, so a
 * correction entered once keeps paying off. This is the only thing in the app
 * that learns, and what it learns is the user's own judgement rather than a
 * model's guess — which is why a correction replaces the reading outright
 * instead of being weighed against it.
 *
 * Two levels: a whole bubble that reads exactly the same again gets the whole
 * fix, and misread *words* inside a fix are also learned on their own, because
 * a misread like `@IÚP` for `GIÚP` recurs in bubbles that are otherwise
 * different.
 */
import { getDb } from '../db';
import { hasImpossibleCharacters } from './lang';

export interface Correction {
  sourceLang: string;
  source: string;
  corrected: string;
  hits: number;
  updatedAt: string;
}

export interface WordCorrection {
  sourceLang: string;
  source: string;
  corrected: string;
  /** The bubble reading this rule was learned from. */
  origin: string;
  hits: number;
  updatedAt: string;
}

/**
 * Lookup key. Case and inner spacing vary between readings of the same
 * lettering, so neither should stop a correction from matching.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Splits sentence punctuation off a word. Symbols OCR misreads letters as
 * (`@`, `&`) are deliberately not in the set: they are part of the word.
 */
const EDGE = /^([.,!?…:;"'“”‘’«»()[\]{}—–-]*)(.*?)([.,!?…:;"'“”‘’«»()[\]{}—–-]*)$/su;

function splitWord(token: string): { lead: string; core: string; trail: string } {
  const m = EDGE.exec(token);
  return m ? { lead: m[1], core: m[2], trail: m[3] } : { lead: '', core: token, trail: '' };
}

/**
 * A word that can only be a misread: it carries a character no word has, or
 * digits mixed into letters (`0K`, `L1KE`). A letters-only change ("THEN" to
 * "THEY") may be a real rewording, and learning it would rewrite every later
 * "THEN", so those stay confined to the bubble they were made in.
 */
function isMisread(word: string): boolean {
  return hasImpossibleCharacters(word) || (/\p{L}/u.test(word) && /\p{N}/u.test(word));
}

/** Levenshtein distance over code points. */
function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[y.length];
}

/**
 * Two words are the same word misread when at most a third of their letters
 * differ (`@IÚP` / `GIÚP`, `0K` / `OK`). A fix that swaps in a different word
 * altogether is a rewording, and teaches nothing about the lettering.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(Array.from(a).length, Array.from(b).length);
  return editDistance(a, b) <= Math.max(1, Math.floor(longest / 3));
}

/**
 * Words of a reading paired with their fixed spelling: an order-preserving
 * alignment that pairs near-identical words and leaves added or dropped words
 * unpaired. Pairing by position instead lost everything whenever a fix also
 * added a word ("LÄ @IÚP" to "LÀ GIÚP ĐỠ").
 */
function substitutions(before: string[], after: string[]): [string, string][] {
  const a = before.map((w) => splitWord(w).core.toLowerCase());
  const b = after.map((w) => splitWord(w).core.toLowerCase());
  const n = a.length;
  const m = b.length;
  const best = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      best[i][j] = sameWord(a[i], b[j])
        ? best[i + 1][j + 1] + 1
        : Math.max(best[i + 1][j], best[i][j + 1]);
    }
  }

  const pairs: [string, string][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sameWord(a[i], b[j]) && best[i][j] === best[i + 1][j + 1] + 1) {
      if (a[i] !== b[j]) pairs.push([before[i], after[j]]);
      i++;
      j++;
    } else if (best[i + 1][j] >= best[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** Carries the letter case of the word being replaced over to its fix. */
function matchCase(original: string, replacement: string): string {
  const letters = original.replace(/[^\p{L}]/gu, '');
  if (!letters) return replacement;
  if (letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    return replacement.toUpperCase();
  }
  if (letters === letters.toLowerCase() && letters !== letters.toUpperCase()) {
    return replacement.toLowerCase();
  }
  return replacement;
}

/**
 * Stores a correction.
 *
 * `source` must be the raw reading (before any earlier correction was applied):
 * that is what the next OCR pass produces, so it is what has to match.
 */
export function saveCorrection(sourceLang: string, source: string, corrected: string): void {
  const key = normalize(source);
  const fixed = corrected.trim();
  if (!key || !fixed) return;
  const db = getDb();
  const saveBubble = db.prepare(
    `INSERT INTO corrections (source_lang, source_text, corrected_text, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(source_lang, source_text) DO UPDATE SET
       corrected_text = excluded.corrected_text,
       updated_at = excluded.updated_at`,
  );
  const forgetWords = db.prepare('DELETE FROM correction_words WHERE source_lang = ? AND origin = ?');
  const saveWord = db.prepare(
    `INSERT INTO correction_words (source_lang, source_word, corrected_word, origin, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_lang, source_word) DO UPDATE SET
       corrected_word = excluded.corrected_word,
       origin = excluded.origin,
       updated_at = excluded.updated_at`,
  );

  db.transaction(() => {
    saveBubble.run(sourceLang, key, fixed);
    // Re-editing a bubble re-teaches its words from scratch.
    forgetWords.run(sourceLang, key);
    for (const [before, after] of substitutions(source.split(/\s+/).filter(Boolean), fixed.split(/\s+/).filter(Boolean))) {
      const from = splitWord(before).core;
      const to = splitWord(after).core;
      if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
      if (!isMisread(from) || isMisread(to) || !/\p{L}/u.test(to)) continue;
      saveWord.run(sourceLang, from.toLowerCase(), to, key);
    }
  })();
}

/** Removes a bubble correction and every word rule it taught. */
export function deleteCorrection(sourceLang: string, source: string): void {
  const key = normalize(source);
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM corrections WHERE source_lang = ? AND source_text = ?').run(sourceLang, key);
    db.prepare('DELETE FROM correction_words WHERE source_lang = ? AND origin = ?').run(sourceLang, key);
  })();
}

export function listCorrections(sourceLang?: string): Correction[] {
  const rows = (
    sourceLang
      ? getDb()
          .prepare('SELECT * FROM corrections WHERE source_lang = ? ORDER BY updated_at DESC')
          .all(sourceLang)
      : getDb().prepare('SELECT * FROM corrections ORDER BY updated_at DESC').all()
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    sourceLang: r.source_lang as string,
    source: r.source_text as string,
    corrected: r.corrected_text as string,
    hits: (r.hits as number) ?? 0,
    updatedAt: r.updated_at as string,
  }));
}

export function listWordCorrections(sourceLang?: string): WordCorrection[] {
  const rows = (
    sourceLang
      ? getDb()
          .prepare('SELECT * FROM correction_words WHERE source_lang = ? ORDER BY updated_at DESC')
          .all(sourceLang)
      : getDb().prepare('SELECT * FROM correction_words ORDER BY updated_at DESC').all()
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    sourceLang: r.source_lang as string,
    source: r.source_word as string,
    corrected: r.corrected_word as string,
    origin: r.origin as string,
    hits: (r.hits as number) ?? 0,
    updatedAt: r.updated_at as string,
  }));
}

/**
 * Applies stored corrections to a page's readings, counting each use so the
 * list can show which entries are actually earning their place. A whole-bubble
 * match wins outright; otherwise learned words are fixed where they appear.
 */
export function applyCorrections(sourceLang: string, texts: string[]): string[] {
  if (texts.length === 0) return texts;
  const db = getDb();
  const find = db.prepare(
    'SELECT corrected_text FROM corrections WHERE source_lang = ? AND source_text = ?',
  );
  const bump = db.prepare(
    'UPDATE corrections SET hits = hits + 1 WHERE source_lang = ? AND source_text = ?',
  );
  const bumpWord = db.prepare(
    'UPDATE correction_words SET hits = hits + 1 WHERE source_lang = ? AND source_word = ?',
  );
  const words = new Map(
    (
      db
        .prepare('SELECT source_word, corrected_word FROM correction_words WHERE source_lang = ?')
        .all(sourceLang) as { source_word: string; corrected_word: string }[]
    ).map((r) => [r.source_word, r.corrected_word]),
  );

  return texts.map((text) => {
    const key = normalize(text);
    const hit = find.get(sourceLang, key) as { corrected_text: string } | undefined;
    if (hit) {
      bump.run(sourceLang, key);
      return hit.corrected_text;
    }
    if (words.size === 0) return text;
    return text
      .split(/(\s+)/)
      .map((token) => {
        const { lead, core, trail } = splitWord(token);
        const fix = core ? words.get(core.toLowerCase()) : undefined;
        if (fix === undefined) return token;
        bumpWord.run(sourceLang, core.toLowerCase());
        return lead + matchCase(core, fix) + trail;
      })
      .join('');
  });
}
