import { Link } from 'react-router-dom';
import type { DiscoverItem } from '../types';

interface Props {
  item: DiscoverItem;
  busy?: boolean;
  onAdd?: (id: string) => void;
}

export default function TitleCard({ item, busy, onAdd }: Props) {
  return (
    <div className="card">
      {item.isSaved && (
        <span className="card-badge badge-ok" title="In your library">
          ✓
        </span>
      )}
      {item.coverUrl || item.isSaved ? (
        <Link to={`/library/${item.id}`}>
          <img
            className="card-cover"
            src={item.isSaved ? `/api/library/${item.id}/cover` : item.coverUrl ?? undefined}
            alt={item.title}
            loading="lazy"
          />
        </Link>
      ) : (
        <div className="card-cover" style={{ display: 'grid', placeItems: 'center' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>no cover</span>
        </div>
      )}
      <div className="card-body">
        <div className="card-title">{item.title}</div>
        <div className="card-meta">
          {[item.year, item.originalLanguage?.toUpperCase(), item.status].filter(Boolean).join(' · ')}
        </div>
        {!item.isSaved && onAdd && (
          <button
            className="btn primary small"
            style={{ marginTop: 10, width: '100%' }}
            disabled={busy}
            onClick={() => onAdd(item.id)}
          >
            {busy ? 'Adding…' : '+ Add to library'}
          </button>
        )}
        {item.isSaved && (
          <Link to={`/library/${item.id}`}>
            <button className="btn small" style={{ marginTop: 10, width: '100%' }}>
              Open
            </button>
          </Link>
        )}
      </div>
    </div>
  );
}