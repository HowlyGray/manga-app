import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import type { OverlayState } from '../hooks';
import type { OverlayBlock } from '../types';

/** `rgb(r,g,b)` -> `rgba(r,g,b,alpha)`; anything else is passed through. */
function withAlpha(fill: string, alpha: number): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(fill);
  return m ? `rgba(${m[1]},${m[2]},${m[3]},${alpha})` : fill;
}

function blockStyle(block: OverlayBlock, width: number, height: number): CSSProperties {
  const pct = (value: number, total: number) => `${(value / total) * 100}%`;
  return {
    left: pct(block.rx0, width),
    top: pct(block.ry0, height),
    width: pct(block.rx1 - block.rx0, width),
    height: pct(block.ry1 - block.ry0, height),
    // `cqw` is 1% of the frame's width, so the text scales with the image no
    // matter how the page is displayed — the server's sizes are in page pixels.
    fontSize: `${(block.fontSize / width) * 100}cqw`,
    lineHeight: block.lineHeight / block.fontSize,
    color: block.color,
    // Bubbles need no background: the page underneath is already the erased
    // render, so a rectangle would only clip the balloon's curve. Text over
    // artwork was never erased, so it still rides on a translucent plate.
    background: block.inBubble ? 'transparent' : withAlpha(block.fill, 0.88),
    borderRadius: block.inBubble ? 0 : `${(block.fontSize / width) * 40}cqw`,
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
  useEffect(() => {
    if (onRequestOverlay) onRequestOverlay(pageNumber);
  }, [onRequestOverlay, pageNumber]);

  const ready = overlay?.status === 'ready' ? overlay.overlay : null;
  // Swap to the erased render only once the text layer is there to replace it,
  // so the page is never briefly blank.
  const showClean = Boolean(cleanSrc) && ready?.translated === true && !showOriginal;

  return (
    <div className="page-frame">
      <img
        ref={imgRef}
        src={showClean ? cleanSrc : src}
        alt={alt}
        loading={lazy ? 'lazy' : undefined}
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

      {ready && !showOriginal && (
        <div className="page-text-layer">
          {ready.blocks.map((block) => (
            <div
              key={block.id}
              className={`page-text${block.inBubble ? '' : ' on-art'}`}
              style={blockStyle(block, ready.width, ready.height)}
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
