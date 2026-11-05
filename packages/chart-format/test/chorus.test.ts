import { describe, expect, it } from 'vitest';
import { hasOverlappingChoruses, normalizeChoruses } from '../src';

describe('normalizeChoruses', () => {
  it('重なる区間を結合し範囲内に切り詰める', () => {
    const r = normalizeChoruses(
      [
        { id: 'b', startMs: 4000, endMs: 9000, confidence: 0.5, source: 'detected' },
        { id: 'a', startMs: -100, endMs: 5000, confidence: 0.9, source: 'manual' },
        { id: 'c', startMs: 12000, endMs: 99999, confidence: 0.3, source: 'detected' },
        { id: 'd', startMs: 20000, endMs: 20000, confidence: 0.3, source: 'detected' },
      ],
      15000,
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ startMs: 0, endMs: 9000, confidence: 0.9, source: 'manual' });
    expect(r[1]).toMatchObject({ startMs: 12000, endMs: 15000 });
    expect(hasOverlappingChoruses(r)).toBe(false);
  });
});
