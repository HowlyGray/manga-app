import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataDir } from '../src/config';
import { chapterDir, pathSegment } from '../src/db';
import { decodeId, encodeId, isLibraryId } from '../src/sources';

const UUID = '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0';
const WEEB = 'weebcentral:01J76XYDT3Z0ZJ7NNG4Q74QFFG';

describe('isLibraryId', () => {
  it('accepts MangaDex UUIDs and provider-prefixed ids', () => {
    expect(isLibraryId(UUID)).toBe(true);
    expect(isLibraryId(WEEB)).toBe(true);
  });

  it.each(['..', '.', '../../etc', 'x/y', 'x\\y', '', 'weebcentral:..', 'weebcentral:', 'not-a-uuid', 42, null])(
    'rejects %j',
    (id) => {
      expect(isLibraryId(id)).toBe(false);
    },
  );
});

describe('pathSegment', () => {
  it('leaves real ids alone and makes provider ids filename-safe', () => {
    expect(pathSegment(UUID)).toBe(UUID);
    expect(pathSegment(WEEB)).toBe('weebcentral_01J76XYDT3Z0ZJ7NNG4Q74QFFG');
  });

  it('cannot climb out of the library', () => {
    expect(pathSegment('..')).toBe('__');
    expect(path.relative(dataDir, chapterDir('..', '..')).startsWith('..')).toBe(false);
  });
});

describe('library ids', () => {
  it('round-trips provider-local ids', () => {
    expect(encodeId('mangadex', UUID)).toBe(UUID);
    expect(decodeId(UUID)).toEqual({ provider: 'mangadex', providerId: UUID });
    expect(decodeId(WEEB)).toEqual({ provider: 'weebcentral', providerId: '01J76XYDT3Z0ZJ7NNG4Q74QFFG' });
  });
});
