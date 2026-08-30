import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OverlayState } from '../hooks';
import type { OverlayBlock } from '../types';

/** `rgb(r,g,b)` -> `rgba(r,g,b,alpha)`; anything else is passed through. */
function withAlpha(fill: string, alpha: number): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(fill);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${alpha})` : fill;
}

/**
 * Places a block over the page.
 *
 * Position is a percentage of the page, so it follows the image at any size.
 * Font size cannot be: it is given in original page pixels and has to be
 * converted with the image's displayed width. That used to be `cqw` on a
 * container-query container, which silently broke page mode — inline-size
 * containment computes an element's width without looking at its contents, so
 * a frame with no explicit width collapsed to zero and the page went blank.
 */
function blockStyle(block: OverlayBlock, overlayWidth: number, height: number, shown: number): CSSProperties {
  const scale = shown / overlayWidth;
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;
  return {
    left: pct(block.rx0, overlayWidth),
    top: pct(block.ry0, height),
    width: pct(block.rx1 - block.rx0, overlayWidth),
    height: pct(block.ry1 - block.ry0, height),
    fontSize: `${block.fontSize * scale}px`,
    lineHeight: block.lineHeight / block.fontSize,
    color: block.color,
    // Bubbles need no background: the page underneath is already the erased
    // render, so a rectangle would only clip the balloon's curve. Text over
    // artwork was never erased, so it still rides on a translucent plate.
    background: block.inBubble ? 'transparent' : withAlpha(block.fill, 0.88),
    borderRadius: block.inBubble ? 0 : `${block.fontSize * scale * 0.4}px`,
  };
}

interface Props {
  src: string;
  /** Same page with the original lettering erased, used under the text layer. */
  cleanSrc?: string;
  alt: string;
  pageNumber: number;
  lazy?: boolean;
  /** Null when the text layer is off. */
  overlay: OverlayState | null;
  /** Temporarily hides the translation so the original lettering shows. */
  showOriginal: boolean;
  onRequestOverlay?: (pageNumber: number) => void;
  imgRef?: (el: HTMLImageElement | null) => void;
}

/**
 * One page image, optionally with the translated text drawn over it as live
 * HTML. Keeping the text as elements rather than baking it into pixels means it
 * stays selectable, scales with the viewport, and leaves the scan untouched.
 */
export default function PageFrame({
  src,
  cleanSrc,
  alt,
  pageNumber,
  lazy,
  overlay,
  showOriginal,
  onRequestOverlay,
  imgRef,
}: Props) {
  const [shownWidth, setShownWidth] = useState(0);
  const img = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (onRequestOverlay) onRequestOverlay(pageNumber);
  }, [onRequestOverlay, pageNumber]);

  // The overlay's font sizes are in page pixels, so they need the width the
  // image is actually drawn at — which changes with the window and the mode.
  const attach = useCallback(
    (el: HTMLImageElement | null) => {
      img.current = el;
      imgRef?.(el);
      if (el) setShownWidth(el.clientWidth);
    },
    [imgRef],
  );

  useEffect(() => {
    const el = img.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setShownWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const ready = overlay?.status === 'ready' ? overlay.overlay : null;
  // Swap to the erased render only once the text layer is there to replace it,
  // so the page is never briefly blank.
  const showClean = Boolean(cleanSrc) && ready?.translated === true && !showOriginal;

  return (
    <div className="page-frame">
      <img
        ref={attach}
        src={showClean ? cleanSrc : src}
        alt={alt}
        loading={lazy ? 'lazy' : undefined}
        onLoad={(e) => setShownWidth(e.currentTarget.clientWidth)}
      />

      {overlay?.status === 'loading' && (
        <div className="page-badge">
          <span className="spinner" />
          Reading page…
        </div>
      )}
      {overlay?.status === 'error' && <div className="page-badge error">{overlay.message}</div>}
      {ready && !ready.translated && (
        <div className="page-badge">
          {ready.reason === 'same-language'
            ? `Already in ${ready.sourceLabel}`
            : 'No text found'}
        </div>
      )}

      {ready && !showOriginal && shownWidth > 0 && (
        <div className="page-text-layer">
          {ready.blocks.map((block) => (
            <div
              key={block.id}
              className={`page-text${block.inBubble ? '' : ' on-art'}`}
              style={blockStyle(block, ready.width, ready.height, shownWidth)}
              title={block.source}
            >
              <span>{block.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
