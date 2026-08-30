import { Link } from 'react-router-dom';
import type { DiscoverItem } from '../types';

interface Props {
  item: DiscoverItem;
  busy?: boolean;
  onAdd?: (id: string) => void;
}

/**
 * A catalogue tile. The whole card is the link and the add action sits on the
 * cover, so every card in a row is exactly as tall as its neighbours — a button
 * in the body made rows ragged whenever a title wrapped to two lines.
 */
export default function TitleCard({ item, busy, onAdd }: Props) {
  const cover = item.isSaved ? `/api/library/${item.id}/cover` : item.coverUrl ?? undefined;
  const meta = [item.year, item.originalLanguage?.toUpperCase(), item.status].filter(Boolean);

  return (
    <article className="card">
      <Link to={`/library/${item.id}`} className="card-link" title={item.title}>
        <div className="card-cover-wrap">
          {cover ? (
            <img className="card-cover" src={cover} alt="" loading="lazy" />
          ) : (
            <div className="card-cover card-cover-empty">no cover</div>
          )}
          {item.isSaved && (
            <span className="card-badge badge-ok" title="In your library">
              ✓ In library
            </span>
          )}
        </div>
        <div className="card-body">
          <h3 className="card-title">{item.title}</h3>
          {meta.length > 0 && <div className="card-meta">{meta.join(' · ')}</div>}
        </div>
      </Link>

      {!item.isSaved && onAdd && (
        <button
          className="card-action"
          disabled={busy}
          title="Add to library"
          aria-label={`Add ${item.title} to library`}
          onClick={() => onAdd(item.id)}
        >
          {busy ? '…' : '+'}
        </button>
      )}
    </article>
  );
}
