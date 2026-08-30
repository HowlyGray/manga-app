/**
 * Speech-bubble detection and text erasure.
 *
 * The previous renderer painted an opaque rectangle of the average surrounding
 * colour over every OCR box, which punched grey slabs through the artwork on
 * any text that was not inside a clean bubble. Instead we flood-fill the
 * uniform region the text sits in, fill its enclosed holes (the glyphs), and
 * repaint only that mask. Text that is *not* inside a uniform region -- sound
 * effects drawn over art -- is reported as such so the renderer can outline it
 * rather than destroy the panel.
 */

export interface PageRaster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BubbleFit {
  /** The block sits inside a uniform region we can safely repaint. */
  inBubble: boolean;
  /** Region colour, as `rgb(r,g,b)`. */
  fill: string;
  /** Readable ink for that fill. */
  textColor: string;
  /** Area the translated text may occupy, in page pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Sub-rectangle the erase mask covers; absent when `inBubble` is false. */
  rect?: Rect;
  /** 1 byte per pixel of `rect`: 1 = repaint with `fill`. */
  mask?: Uint8Array;
}

/** Axis-aligned box in page pixels. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

interface Ring {
  r: number;
  g: number;
  b: number;
  /** Share of sampled pixels close to the dominant colour, 0-1. */
  dominance: number;
  count: number;
}

/**
 * Samples a thin band just outside the text box and looks for a *dominant*
 * colour rather than a uniform one.
 *
 * Mean and standard deviation reject screentone-shaded bubbles, which are very
 * common: black halftone dots on white have a huge spread but an obvious modal
 * colour. Those bubbles were the ones that ended up with the translation
 * printed on top of the original lettering.
 */
function sampleRing(page: PageRaster, box: Box): Ring {
  const pad = 4;
  // 4 bits per channel is coarse enough to survive JPEG noise and halftone.
  const bins = new Map<number, number>();
  const samples: number[] = [];

  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= page.width || y >= page.height) return;
    const i = (y * page.width + x) * 4;
    const r = page.data[i];
    const g = page.data[i + 1];
    const b = page.data[i + 2];
    samples.push(r, g, b);
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  };

  const step = Math.max(1, Math.round((box.x1 - box.x0 + box.y1 - box.y0) / 200));
  for (let x = box.x0 - pad; x <= box.x1 + pad; x += step) {
    push(x, box.y0 - pad);
    push(x, box.y1 + pad);
  }
  for (let y = box.y0 - pad; y <= box.y1 + pad; y += step) {
    push(box.x0 - pad, y);
    push(box.x1 + pad, y);
  }
  const count = samples.length / 3;
  if (count === 0) return { r: 255, g: 255, b: 255, dominance: 0, count: 0 };

  let bestKey = 0;
  let bestCount = 0;
  for (const [key, n] of bins) {
    if (n > bestCount) {
      bestCount = n;
      bestKey = key;
    }
  }
  const modeR = ((bestKey >> 8) & 0xf) * 16 + 8;
  const modeG = ((bestKey >> 4) & 0xf) * 16 + 8;
  const modeB = (bestKey & 0xf) * 16 + 8;

  // Refine towards the true colour of the pixels that voted for the mode.
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let near = 0;
  for (let i = 0; i < samples.length; i += 3) {
    if (
      Math.abs(samples[i] - modeR) <= 24 &&
      Math.abs(samples[i + 1] - modeG) <= 24 &&
      Math.abs(samples[i + 2] - modeB) <= 24
    ) {
      sumR += samples[i];
      sumG += samples[i + 1];
      sumB += samples[i + 2];
      near++;
    }
  }
  if (near === 0) return { r: modeR, g: modeG, b: modeB, dominance: 0, count };
  return {
    r: sumR / near,
    g: sumG / near,
    b: sumB / near,
    dominance: near / count,
    count,
  };
}

/**
 * Flood-fills the uniform region containing `box`, then closes its interior
 * holes so the glyphs themselves end up in the mask.
 */
function regionMask(
  page: PageRaster,
  rect: Rect,
  box: Box,
  seed: { r: number; g: number; b: number },
  tolerance: number,
): { mask: Uint8Array; covered: number; bounds: Box } | null {
  const { x, y, w, h } = rect;
  const mask = new Uint8Array(w * h);
  const queue: number[] = [];

  const within = (px: number, py: number): boolean => {
    const i = ((y + py) * page.width + (x + px)) * 4;
    return (
      Math.abs(page.data[i] - seed.r) <= tolerance &&
      Math.abs(page.data[i + 1] - seed.g) <= tolerance &&
      Math.abs(page.data[i + 2] - seed.b) <= tolerance
    );
  };

  // Seed from the ring around the text box: those pixels are bubble interior.
  const ringPad = 4;
  const pushSeed = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const idx = py * w + px;
    if (mask[idx] || !within(px, py)) return;
    mask[idx] = 1;
    queue.push(idx);
  };
  for (let px = box.x0 - ringPad; px <= box.x1 + ringPad; px++) {
    pushSeed(px - x, box.y0 - ringPad - y);
    pushSeed(px - x, box.y1 + ringPad - y);
  }
  for (let py = box.y0 - ringPad; py <= box.y1 + ringPad; py++) {
    pushSeed(box.x0 - ringPad - x, py - y);
    pushSeed(box.x1 + ringPad - x, py - y);
  }
  if (queue.length === 0) return null;

  while (queue.length > 0) {
    const idx = queue.pop()!;
    const px = idx % w;
    const py = (idx - px) / w;
    if (px > 0 && !mask[idx - 1] && within(px - 1, py)) {
      mask[idx - 1] = 1;
      queue.push(idx - 1);
    }
    if (px < w - 1 && !mask[idx + 1] && within(px + 1, py)) {
      mask[idx + 1] = 1;
      queue.push(idx + 1);
    }
    if (py > 0 && !mask[idx - w] && within(px, py - 1)) {
      mask[idx - w] = 1;
      queue.push(idx - w);
    }
    if (py < h - 1 && !mask[idx + w] && within(px, py + 1)) {
      mask[idx + w] = 1;
      queue.push(idx + w);
    }
  }

  // Everything reachable from the sub-rect border *without* crossing the region
  // is outside it; whatever is left over is enclosed by the region -- i.e. the
  // glyphs we want to erase.
  const outside = new Uint8Array(w * h);
  const border: number[] = [];
  const pushOutside = (px: number, py: number) => {
    const idx = py * w + px;
    if (mask[idx] || outside[idx]) return;
    outside[idx] = 1;
    border.push(idx);
  };
  for (let px = 0; px < w; px++) {
    pushOutside(px, 0);
    pushOutside(px, h - 1);
  }
  for (let py = 0; py < h; py++) {
    pushOutside(0, py);
    pushOutside(w - 1, py);
  }
  while (border.length > 0) {
    const idx = border.pop()!;
    const px = idx % w;
    const py = (idx - px) / w;
    if (px > 0) pushOutside(px - 1, py);
    if (px < w - 1) pushOutside(px + 1, py);
    if (py > 0) pushOutside(px, py - 1);
    if (py < h - 1) pushOutside(px, py + 1);
  }

  let bx0 = w;
  let by0 = h;
  let bx1 = -1;
  let by1 = -1;
  let covered = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = py * w + px;
      if (!mask[idx] && !outside[idx]) mask[idx] = 1;
      if (!mask[idx]) continue;
      covered++;
      if (px < bx0) bx0 = px;
      if (px > bx1) bx1 = px;
      if (py < by0) by0 = py;
      if (py > by1) by1 = py;
    }
  }
  if (bx1 < bx0 || by1 < by0) return null;

  return {
    mask,
    covered,
    bounds: { x0: x + bx0, y0: y + by0, x1: x + bx1, y1: y + by1 },
  };
}

/**
 * Works out whether a text block sits inside a bubble and, if so, which pixels
 * to repaint. Callers pass a raster grabbed once per page, not per block.
 */
export function fitBubble(page: PageRaster, block: Box, others: Box[] = []): BubbleFit {
  const bw = block.x1 - block.x0;
  const bh = block.y1 - block.y0;
  const plainAt = (r: number, g: number, b: number): BubbleFit => ({
    inBubble: false,
    fill: `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`,
    textColor: luminance(r, g, b) < 120 ? '#ffffff' : '#000000',
    // Give the text a little more room than the source box: the renderer draws
    // it on a translucent plate rather than erasing, so it needs the margin.
    x0: block.x0 - bw * 0.06,
    y0: block.y0 - bh * 0.08,
    x1: block.x1 + bw * 0.06,
    y1: block.y1 + bh * 0.08,
  });
  if (bw <= 0 || bh <= 0) return plainAt(255, 255, 255);

  const ring = sampleRing(page, block);
  // No colour owns the majority of the ring: the text is over artwork, and
  // erasing would wreck the panel. Keep the sampled colour for the plate.
  const plain = ring.count > 0 ? plainAt(ring.r, ring.g, ring.b) : plainAt(255, 255, 255);
  if (ring.count === 0 || ring.dominance < 0.55) return plain;

  const margin = Math.round(clamp(Math.max(bw, bh) * 0.6, 18, 220));
  const rect: Rect = {
    x: Math.round(clamp(block.x0 - margin, 0, page.width - 1)),
    y: Math.round(clamp(block.y0 - margin, 0, page.height - 1)),
    w: 0,
    h: 0,
  };
  rect.w = Math.round(clamp(block.x1 + margin, 0, page.width) - rect.x);
  rect.h = Math.round(clamp(block.y1 + margin, 0, page.height) - rect.y);
  if (rect.w < 4 || rect.h < 4) return plain;

  // A less dominant colour means a noisier region, so allow more drift.
  const tolerance = clamp(24 + (1 - ring.dominance) * 90, 24, 66);
  const region = regionMask(page, rect, block, ring, tolerance);
  if (!region) return plain;

  // If the region does not actually cover the text, it is not the bubble.
  const blockArea = Math.max(1, bw * bh);
  const overlapW = Math.max(0, Math.min(region.bounds.x1, block.x1) - Math.max(region.bounds.x0, block.x0));
  const overlapH = Math.max(0, Math.min(region.bounds.y1, block.y1) - Math.max(region.bounds.y0, block.y0));
  if ((overlapW * overlapH) / blockArea < 0.55) return plain;

  const fillLum = luminance(ring.r, ring.g, ring.b);
  return {
    inBubble: true,
    fill: `rgb(${Math.round(ring.r)},${Math.round(ring.g)},${Math.round(ring.b)})`,
    textColor: fillLum < 120 ? '#ffffff' : '#000000',
    ...grownBox(region.mask, rect, block, others),
    rect,
    mask: region.mask,
  };
}

/**
 * Largest box around the text that stays inside the filled region.
 *
 * Grows outward from the lettering itself, one edge at a time, stopping when a
 * strip would cross the balloon outline. Scaling the region's bounding box
 * instead (the earlier approach) broke on two balloons that touch: they
 * flood-fill into one region, so the box was centred between them and spilled
 * over the neighbour.
 */
function grownBox(mask: Uint8Array, rect: Rect, block: Box, others: Box[]): Box {
  const { x, y, w, h } = rect;
  let x0 = Math.round(clamp(block.x0 - x, 0, w - 1));
  let x1 = Math.round(clamp(block.x1 - x, 0, w - 1));
  let y0 = Math.round(clamp(block.y0 - y, 0, h - 1));
  let y1 = Math.round(clamp(block.y1 - y, 0, h - 1));

  /** Share of a candidate strip that lies inside the region. */
  const strip = (sx0: number, sy0: number, sx1: number, sy1: number): number => {
    let inside = 0;
    let total = 0;
    for (let py = sy0; py <= sy1; py++) {
      for (let px = sx0; px <= sx1; px++) {
        total++;
        if (mask[py * w + px]) inside++;
      }
    }
    return total === 0 ? 0 : inside / total;
  };

  /**
   * Two balloons that touch flood-fill into one region, so the mask alone does
   * not stop growth at the balloon they share. Another block's lettering does:
   * a layout area must never swallow text that belongs to a different bubble.
   */
  const hitsNeighbour = (sx0: number, sy0: number, sx1: number, sy1: number): boolean =>
    others.some(
      (o) => x + sx1 >= o.x0 - 2 && x + sx0 <= o.x1 + 2 && y + sy1 >= o.y0 - 2 && y + sy0 <= o.y1 + 2,
    );

  // The text may not be worth much more room than it already had; a balloon is
  // rarely more than a couple of times the size of its own lettering.
  const maxW = Math.max(24, (block.x1 - block.x0) * 2.4);
  const maxH = Math.max(24, (block.y1 - block.y0) * 2.4);
  const step = Math.max(1, Math.round(Math.min(w, h) / 90));
  const clear = 0.94;

  for (let guard = 0; guard < 400; guard++) {
    let grew = false;
    if (
      y0 - step >= 0 &&
      y1 - y0 < maxH &&
      strip(x0, y0 - step, x1, y0 - 1) >= clear &&
      !hitsNeighbour(x0, y0 - step, x1, y0 - 1)
    ) {
      y0 -= step;
      grew = true;
    }
    if (
      y1 + step < h &&
      y1 - y0 < maxH &&
      strip(x0, y1 + 1, x1, y1 + step) >= clear &&
      !hitsNeighbour(x0, y1 + 1, x1, y1 + step)
    ) {
      y1 += step;
      grew = true;
    }
    if (
      x0 - step >= 0 &&
      x1 - x0 < maxW &&
      strip(x0 - step, y0, x0 - 1, y1) >= clear &&
      !hitsNeighbour(x0 - step, y0, x0 - 1, y1)
    ) {
      x0 -= step;
      grew = true;
    }
    if (
      x1 + step < w &&
      x1 - x0 < maxW &&
      strip(x1 + 1, y0, x1 + step, y1) >= clear &&
      !hitsNeighbour(x1 + 1, y0, x1 + step, y1)
    ) {
      x1 += step;
      grew = true;
    }
    if (!grew) break;
  }

  return { x0: x + x0, y0: y + y0, x1: x + x1, y1: y + y1 };
}

/** Paints a fit's mask into the page raster, erasing the original lettering. */
export function eraseInto(page: PageRaster, fit: BubbleFit): void {
  if (!fit.inBubble || !fit.mask || !fit.rect) return;
  const { x, y, w, h } = fit.rect;
  const match = /rgb\((\d+),(\d+),(\d+)\)/.exec(fit.fill);
  if (!match) return;
  const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (!fit.mask[py * w + px]) continue;
      const i = ((y + py) * page.width + (x + px)) * 4;
      page.data[i] = r;
      page.data[i + 1] = g;
      page.data[i + 2] = b;
      page.data[i + 3] = 255;
    }
  }
}
