import { describe, expect, it } from 'vitest';
import { buildLanes, clampScroll, makeScale, msOf, pickTickStepMs, visibleRange, xOf, zoomAround } from '../../src/renderer/src/timeline/geometry';
import { buildSnapGrid, snapToGrid } from '../../src/renderer/src/timeline/snap';
import { shouldApplyResult } from '../../src/renderer/src/analysis/client';

describe('timeline geometry', () => {
  it('時刻とピクセルを相互変換する', () => {
    const s = makeScale(100, 2000);
    expect(xOf(s, 2000)).toBe(0);
    expect(xOf(s, 3000)).toBe(100);
    expect(msOf(s, 50)).toBe(2500);
    expect(msOf(s, xOf(s, 12345))).toBeCloseTo(12345, 6);
  });
  it('カーソル位置を固定してズームする', () => {
    const r = zoomAround(100, 0, 200, 2, 60000, 1000);
    expect(r.zoomPxPerSec).toBe(200);
    expect(msOf(makeScale(r.zoomPxPerSec, r.scrollMs), 200)).toBeCloseTo(2000, 3);
    expect(clampScroll(-5, 100, 60000, 1000)).toBe(0);
    expect(clampScroll(999999, 100, 60000, 1000)).toBeLessThanOrEqual(60000);
  });
  it('レーンは波形→L1→L2→L3→L4 の順', () => {
    const lanes = buildLanes({ '1': true, '2': false, '3': true, '4': true });
    expect(lanes.map((l) => (l.kind === 'level' ? `L${l.level}` : l.kind))).toEqual(['ruler', 'chorus', 'waveform', 'L1', 'L3', 'L4']);
  });
  it('目盛り間隔はズームに応じて変わる', () => {
    expect(pickTickStepMs(0.01).major).toBeGreaterThanOrEqual(5000);
    expect(pickTickStepMs(2).major).toBeLessThanOrEqual(50);
  });
  it('可視範囲を二分探索で求める', () => {
    expect(visibleRange([0, 10, 20, 30, 40], 10, 30)).toEqual([1, 4]);
    expect(visibleRange([], 0, 10)).toEqual([0, 0]);
  });
});

describe('snap', () => {
  it('拍・半拍・4分割・オンセットへ吸着する', () => {
    const analysis = { beats: [0, 500, 1000, 1500], onsets: [{ timeMs: 123, strength: 1 }, { timeMs: 777, strength: 1 }] };
    expect(snapToGrid(260, buildSnapGrid(analysis, 'beat', 120, 0, 2000))).toBe(500);
    expect(snapToGrid(260, buildSnapGrid(analysis, 'half', 120, 0, 2000))).toBe(250);
    expect(snapToGrid(130, buildSnapGrid(analysis, 'quarter', 120, 0, 2000))).toBe(125);
    expect(snapToGrid(700, buildSnapGrid(analysis, 'onset', 120, 0, 2000))).toBe(777);
    // 解析がなければ BPM からグリッドを作る
    expect(snapToGrid(1490, buildSnapGrid(null, 'beat', 120, 0, 2000))).toBe(1500);
    expect(snapToGrid(1490, [])).toBe(1490);
    expect(snapToGrid(100, [0, 1000], 50)).toBe(100);
  });
});

describe('analysis job generation', () => {
  it('キャンセル済み・古いジョブの結果は適用しない', () => {
    const cancelled = new Set([1]);
    expect(shouldApplyResult(2, 2, cancelled)).toBe(true);
    expect(shouldApplyResult(2, 1, cancelled)).toBe(false);
    expect(shouldApplyResult(1, 1, cancelled)).toBe(false);
  });
});
