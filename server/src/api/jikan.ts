import { config } from '../config';
import { RateLimiter, getJson } from '../util/net';

const BASE = 'https://api.jikan.moe/v4';

const jikan = new RateLimiter(config.jikan.apiIntervalMs);

export interface JikanMangaMeta {
  malId: number;
  title: string;
  score: number | null;
  synopsis: string | null;
  genres: string[];
  imageUrl: string | null;
  url: string;
}

interface JikanSearchResponse {
  data?: {
    mal_id: number;
    title: string;
    title_english?: string | null;
    score?: number | null;
    synopsis?: string | null;
    genres?: { name: string }[];
    images?: { jpg?: { image_url?: string } };
    url?: string;
  }[];
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Rate-limit-aware search. Use sparingly; enrich once per title. */
export async function searchMangaMeta(title: string): Promise<JikanMangaMeta | null> {
  const q = encodeURIComponent(title);
  const url = `${BASE}/manga?q=${q}&limit=5&order_by=members&sort=desc`;
  const res = await jikan.run(() => getJson<JikanSearchResponse>(url));

  const items = res?.data ?? [];
  if (items.length === 0) return null;

  const target = normalize(title);
  const scored = items.map((it, index) => {
    const name = normalize(it.title) || normalize(it.title_english ?? '');
    let score = 0;
    if (name === target) score = 100;
    else if (name.includes(target) || target.includes(name)) score = 60;
    const memberBoost = Math.max(0, 30 - index * 5);
    return { item: it, score: score + (score > 0 ? memberBoost : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score <= 0) return null;

  const it = best.item;
  return {
    malId: it.mal_id,
    title: it.title,
    score: it.score ?? null,
    synopsis: it.synopsis ?? null,
    genres: (it.genres ?? []).map((g) => g.name),
    imageUrl: it.images?.jpg?.image_url ?? null,
    url: it.url ?? '',
  };
}