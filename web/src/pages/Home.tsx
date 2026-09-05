import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { HomeResponse, SourceInfo, Tag } from '../types';
import TitleCard from '../components/TitleCard';

/** Genres worth a one-click shortcut; the full list lives in the browse view. */
const FEATURED_GENRES = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Fantasy',
  'Horror',
  'Isekai',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Thriller',
];

function browseUrl(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  return `/browse?${search.toString()}`;
}

export default function Home() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [source, setSource] = useState('');
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.sources().then(
      (r) => {
        setSources(r.sources);
        setSource((current) => current || r.sources[0]?.id || '');
      },
      () => setSources([]),
    );
  }, []);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setHome(null);
    setError('');
    api.home(source).then(
      (r) => !cancelled && setHome(r),
      (e) => !cancelled && setError((e as Error).message),
    );
    api.tags(source).then(
      (r) => !cancelled && setTags(r.tags),
      () => !cancelled && setTags([]),
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  const genres = FEATURED_GENRES.map((name) => tags.find((t) => t.name === name)).filter(
    (t): t is Tag => Boolean(t),
  );

  return (
    <div>
      <section className="hero">
        <h1 className="hero-title">What's moving right now</h1>
        <form
          className="hero-search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(browseUrl({ q: q.trim() || undefined, source }));
          }}
        >
          <input
            className="search"
            placeholder="Search every title on this source…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn primary" type="submit">
            Search
          </button>
          {sources.length > 1 && (
            <select className="select" value={source} onChange={(e) => setSource(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </form>
      </section>

      {genres.length > 0 && (
        <section className="shelf">
          <div className="shelf-head">
            <h2 className="shelf-title">Browse by genre</h2>
            <Link className="shelf-more" to={browseUrl({ source })}>
              All genres →
            </Link>
          </div>
          <div className="chips wrap">
            {genres.map((g) => (
              <Link key={g.id} className="chip" to={browseUrl({ source, tags: g.id })}>
                {g.name}
              </Link>
            ))}
          </div>
        </section>
      )}

      {error && <div className="error">{error}</div>}

      {!home && !error && (
        <div className="shelf">
          <div className="skeleton skeleton-line" style={{ width: 180, height: '1rem' }} />
          <div className="rail">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="rail-item card skeleton-card">
                <div className="card-cover skeleton" />
                <div className="card-body">
                  <div className="skeleton skeleton-line" />
                  <div className="skeleton skeleton-line short" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {home?.shelves.map((shelf) => (
        <section key={shelf.id} className="shelf">
          <div className="shelf-head">
            <div>
              <h2 className="shelf-title">{shelf.title}</h2>
              <div className="shelf-sub">{shelf.subtitle}</div>
            </div>
            {shelf.browse && (
              <Link
                className="shelf-more"
                to={browseUrl({
                  source: home.source,
                  sort: shelf.browse.sort,
                  since: shelf.browse.createdSince,
                })}
              >
                See all →
              </Link>
            )}
          </div>
          {/* A horizontal rail keeps four rows of trends on one screen. */}
          <div className="rail">
            {shelf.titles.map((t) => (
              <div key={`${shelf.id}-${t.id}`} className="rail-item">
                <TitleCard item={t} />
              </div>
            ))}
          </div>
        </section>
      ))}

      {home?.shelves.length === 0 && !error && (
        <div className="empty">This source has nothing to feature. Try the browse view.</div>
      )}
    </div>
  );
}
