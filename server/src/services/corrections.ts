/**
 * Readings the user has corrected by hand.
 *
 * OCR misreads the same lettering the same way across a whole series, so a
 * correction entered once keeps paying off. This is the only thing in the app
 * that learns, and what it learns is the user's own judgement rather than a
 * model's guess — which is why a correction replaces the reading outright
 * instead of being weighed against it.
 */
import { getDb } from '../db';

export interface Correction {
  sourceLang: string;
  source: string;
  corrected: string;
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

export function saveCorrection(sourceLang: string, source: string, corrected: string): void {
  const key = normalize(source);
  if (!key || !corrected.trim()) return;
  getDb()
    .prepare(
      `INSERT INTO corrections (source_lang, source_text, corrected_text, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(source_lang, source_text) DO UPDATE SET
         corrected_text = excluded.corrected_text,
         updated_at = excluded.updated_at`,
    )
    .run(sourceLang, key, corrected.trim());
}

export function deleteCorrection(sourceLang: string, source: string): void {
  getDb()
    .prepare('DELETE FROM corrections WHERE source_lang = ? AND source_text = ?')
    .run(sourceLang, normalize(source));
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

/**
 * Applies stored corrections to a page's readings, counting each use so the
 * list can show which entries are actually earning their place.
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
  return texts.map((text) => {
    const key = normalize(text);
    const hit = find.get(sourceLang, key) as { corrected_text: string } | undefined;
    if (!hit) return text;
    bump.run(sourceLang, key);
    return hit.corrected_text;
  });
}
