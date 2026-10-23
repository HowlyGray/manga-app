import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chapterDir } from '../src/db';
import { refineRegions } from '../src/services/pageOcr';

const T = '11111111-2222-4333-8444-555555555555';
const C = '66666666-7777-4888-8999-000000000000';

describe('refineRegions', () => {
  it('serves the re-read of the same balloons from the cache', async () => {
    const page = { titleId: T, chapterId: C, pageNumber: 3 };
    const regions = [{ id: 0, x0: 10.5, y0: 20, x1: 200.25, y1: 90 }];
    const ocrDir = path.join(chapterDir(T, C), '.ocr');
    fs.mkdirSync(ocrDir, { recursive: true });
    fs.writeFileSync(
      path.join(ocrDir, '3.en.refine.json'),
      JSON.stringify({ regions: JSON.stringify(regions), texts: [[0, 'CACHED READING']] }),
    );
    // The image does not exist: anything but a cache hit would throw.
    const out = await refineRegions(path.join(chapterDir(T, C), 'missing.png'), regions, 'en', page);
    expect(out.get(0)).toBe('CACHED READING');
  });

  it('leaves Japanese pages to their first reading', async () => {
    const out = await refineRegions('missing.png', [{ id: 0, x0: 0, y0: 0, x1: 50, y1: 50 }], 'ja');
    expect(out.size).toBe(0);
  });
});
