interface Props {
  page: number;
  /** Total pages, or 0 when the source does not report a count. */
  pages: number;
  /** Whether another page exists; the only signal when `pages` is 0. */
  hasMore: boolean;
  onChange: (page: number) => void;
}

const GAP = '…';

/**
 * Page numbers to render: always the first and last, the current page with two
 * neighbours either side, and a gap marker where numbers were skipped.
 */
function pageItems(page: number, pages: number): (number | typeof GAP)[] {
  if (pages <= 9) return Array.from({ length: pages }, (_, i) => i + 1);

  const items = new Set<number>([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) {
    if (p > 1 && p < pages) items.add(p);
  }
  // Keep the row a stable width near the ends, where the window is clipped.
  if (page <= 4) for (let p = 2; p <= 5; p++) items.add(p);
  if (page >= pages - 3) for (let p = pages - 4; p < pages; p++) items.add(p);

  const sorted = [...items].sort((a, b) => a - b);
  const out: (number | typeof GAP)[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(GAP);
    out.push(p);
  });
  return out;
}

export default function Pagination({ page, pages, hasMore, onChange }: Props) {
  const known = pages > 0;
  const canPrev = page > 1;
  const canNext = known ? page < pages : hasMore;
  if (!canPrev && !canNext) return null;

  return (
    <nav className="pager" aria-label="Pagination">
      <button className="pager-btn" disabled={!canPrev} onClick={() => onChange(page - 1)}>
        ‹<span className="pager-word"> Prev</span>
      </button>

      {known ? (
        <ol className="pager-pages">
          {pageItems(page, pages).map((item, i) =>
            item === GAP ? (
              <li key={`gap-${i}`} className="pager-gap" aria-hidden="true">
                {GAP}
              </li>
            ) : (
              <li key={item}>
                <button
                  className={`pager-btn${item === page ? ' active' : ''}`}
                  aria-current={item === page ? 'page' : undefined}
                  onClick={() => onChange(item)}
                >
                  {item}
                </button>
              </li>
            ),
          )}
        </ol>
      ) : (
        // A source that reports no count can still be walked one page at a time.
        <span className="pager-current">Page {page}</span>
      )}

      <button className="pager-btn" disabled={!canNext} onClick={() => onChange(page + 1)}>
        <span className="pager-word">Next </span>›
      </button>

      {known && pages > 9 && (
        <form
          className="pager-jump"
          onSubmit={(e) => {
            e.preventDefault();
            const value = Number(new FormData(e.currentTarget).get('page'));
            if (Number.isFinite(value)) onChange(Math.min(pages, Math.max(1, Math.round(value))));
            e.currentTarget.reset();
          }}
        >
          <input name="page" type="number" min={1} max={pages} placeholder="Go to…" aria-label="Go to page" />
        </form>
      )}
    </nav>
  );
}
