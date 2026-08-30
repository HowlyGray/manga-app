import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { LibraryTitle } from '../types';

type Sort = 'default' | 'title' | 'progress' | 'downloaded';

const SORTS: { key: Sort; label: string }[] = [
  { key: 'default', label: 'Recently added' },
  { key: 'progress', label: 'In progress first' },
  { key: 'title', label: 'Title A–Z' },
  { key: 'downloaded', label: 'Most downloaded' },
];

function LibraryCard({ t }: { t: LibraryTitle }) {
  const pct = t.total_chapters > 0 ? Math.round((t.downloaded_chapters / t.total_chapters) * 100) : 0;
  const meta = [
    (t.original_lang ?? '').toUpperCase() || null,
    t.year,
    t.jikan_score != null ? `★ ${t.jikan_score}` : null,
  ].filter(Boolean);

  return (
    <article className="card">
      <Link to={`/library/${t.id}`} className="card-link" title={t.title}>
        <div className="card-cover-wrap">
          <img
            className="card-cover"
            src={`/api/library/${t.id}/cover`}
            alt=""
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
          {t.progress_chapter_id && <span className="card-badge badge-reading">Reading</span>}
        </div>
        <div className="card-body">
          <h3 className="card-title">{t.title}</h3>
          {meta.length > 0 && <div className="card-meta">{meta.join(' · ')}</div>}
          <div className="card-progress" title={`${t.downloaded_chapters} of ${t.total_chapters} chapters downloaded`}>
            <div className="card-progress-bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <span className="card-meta">
              {t.downloaded_chapters}/{t.total_chapters}
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

export default function Library() {
  const [titles, setTitles] = useState<LibraryTitle[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('default');

  async function refresh() {
    setRefreshing(true);
    try {
      setTitles(await api.library());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const shown = useMemo(() => {
    if (!titles) return [];
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? titles.filter((t) => t.title.toLowerCase().includes(needle))
      : [...titles];
    switch (sort) {
      case 'title':
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case 'downloaded':
        return list.sort((a, b) => b.downloaded_chapters - a.downloaded_chapters);
      case 'progress':
        return list.sort(
          (a, b) => Number(Boolean(b.progress_chapter_id)) - Number(Boolean(a.progress_chapter_id)),
        );
      default:
        return list;
    }
  }, [titles, filter, sort]);

  const reading = useMemo(() => (titles ?? []).filter((t) => t.progress_chapter_id), [titles]);

  if (error) return <div className="error">{error}</div>;
  if (!titles) {
    return (
      <div className="grid">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="card skeleton-card">
            <div className="card-cover skeleton" />
            <div className="card-body">
              <div className="skeleton skeleton-line" />
              <div className="skeleton skeleton-line short" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (titles.length === 0) {
    return (
      <div className="empty">
        <p>Your library is empty.</p>
        <p>Browse the Discover tab and add a series — chapters download locally.</p>
        <p>
          <Link to="/">
            <button className="btn primary">Go to Discover</button>
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      {reading.length > 0 && filter === '' && (
        <section className="shelf">
          <h2 className="shelf-title">Continue reading</h2>
          <div className="grid">
            {reading.map((t) => (
              <LibraryCard key={`reading-${t.id}`} t={t} />
            ))}
          </div>
        </section>
      )}

      <div className="filterbar">
        <h2 className="shelf-title" style={{ margin: 0 }}>
          Library <span className="muted">({titles.length})</span>
        </h2>
        <input
          className="search"
          placeholder="Filter your library…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : '⟳ Refresh'}
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="empty">No title matches that filter.</div>
      ) : (
        <div className="grid">
          {shown.map((t) => (
            <LibraryCard key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}
