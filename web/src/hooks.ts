import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { PageOverlay } from './types';

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export type OverlayState =
  | { status: 'loading' }
  | { status: 'ready'; overlay: PageOverlay }
  | { status: 'error'; message: string };

/**
 * Fetches page text-layers on demand, a couple at a time.
 *
 * The first request for a page runs OCR and translation server-side, so pages
 * ask for their own overlay as they render rather than the reader pulling a
 * whole chapter up front. Results are cached on the server, so revisiting is
 * immediate.
 */
export function usePageOverlays(
  titleId: string | undefined,
  chapterId: string | undefined,
  target: string,
  concurrency = 2,
): {
  states: Map<number, OverlayState>;
  request: (pageNumber: number) => void;
  refresh: (pageNumber: number) => void;
} {
  const key = `${titleId ?? ''}|${chapterId ?? ''}|${target}`;
  const [states, setStates] = useState<Map<number, OverlayState>>(new Map());
  const [activeKey, setActiveKey] = useState(key);
  const queue = useRef<number[]>([]);
  const active = useRef(0);
  const seen = useRef<Set<number>>(new Set());
  /** Pages to re-read past the server cache, after a correction was saved. */
  const forced = useRef<Set<number>>(new Set());
  const token = useRef(0);

  // Reset during render, not in an effect: React runs child effects before the
  // parent's, so an effect here would wipe the queue the pages had just filled
  // and no overlay would ever be fetched.
  if (activeKey !== key) {
    setActiveKey(key);
    setStates(new Map());
    token.current += 1;
    queue.current = [];
    active.current = 0;
    seen.current = new Set();
  }

  const pump = useCallback(() => {
    if (!titleId || !chapterId || !target) return;
    const mine = token.current;
    while (active.current < concurrency && queue.current.length > 0) {
      const pageNumber = queue.current.shift()!;
      active.current += 1;
      api
        .pageOverlay(titleId, chapterId, pageNumber, target, forced.current.delete(pageNumber))
        .then(
          (overlay): OverlayState => ({ status: 'ready', overlay }),
          (err: Error): OverlayState => ({ status: 'error', message: err.message }),
        )
        .then((state) => {
          if (token.current !== mine) return;
          setStates((prev) => new Map(prev).set(pageNumber, state));
        })
        .finally(() => {
          if (token.current !== mine) return;
          active.current -= 1;
          pump();
        });
    }
  }, [titleId, chapterId, target, concurrency]);

  const request = useCallback(
    (pageNumber: number) => {
      if (!titleId || !chapterId || !target) return;
      if (seen.current.has(pageNumber)) return;
      seen.current.add(pageNumber);
      setStates((prev) => new Map(prev).set(pageNumber, { status: 'loading' }));
      queue.current.push(pageNumber);
      pump();
    },
    [titleId, chapterId, target, pump],
  );

  /** Re-reads one page, bypassing the cached overlay. */
  const refresh = useCallback(
    (pageNumber: number) => {
      if (!titleId || !chapterId || !target) return;
      forced.current.add(pageNumber);
      seen.current.add(pageNumber);
      setStates((prev) => new Map(prev).set(pageNumber, { status: 'loading' }));
      queue.current.push(pageNumber);
      pump();
    },
    [titleId, chapterId, target, pump],
  );

  return { states, request, refresh };
}
