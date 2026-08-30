import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { LibraryTitle } from '../types';

export default function Library() {
  const [titles, setTitles] = useState<LibraryTitle[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

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

  if (error) return <div className="error">{error}</div>;
  if (!titles) return <div className="loading"><span className="spinner" />Loading…</div>;

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
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>
          Library <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({titles.length})</span>
        </h2>
        <button className="btn small" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : '⟳ Refresh'}
        </button>
      </div>
      <div className="grid">
        {titles.map((t) => (
          <Link key={t.id} to={`/library/${t.id}`} className="card">
            <img
              className="card-cover"
              src={`/api/library/${t.id}/cover`}
              alt={t.title}
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            <div className="card-body">
              <div className="card-title">{t.title}</div>
              <div className="card-meta">
                {(t.original_lang ?? '').toUpperCase()}
                {t.year ? ` · ${t.year}` : ''}
                {t.jikan_score != null ? ` · ★ ${t.jikan_score}` : ''}
              </div>
              <div className="card-meta">
                {t.downloaded_chapters}/{t.total_chapters} ch downloaded
              </div>
              {t.progress_chapter_id && (
                <div className="card-meta" style={{ color: 'var(--accent)' }}>
                  In progress
                </div>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}