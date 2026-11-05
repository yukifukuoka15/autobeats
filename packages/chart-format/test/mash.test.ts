import { describe, expect, it } from 'vitest';
import { MASH, conflictsWithOtherLevel, findCrossLevelConflicts, findNearestCrossLevelConflict, isInMashSpan, judgeMash, mashRequiredPresses, noteEndMs, usedTimesOf, validateChart, type ChartNote } from '../src';
import { sampleChart } from './validate.test';

const tap = (id: string, hitAtMs: number): ChartNote => ({ id, hitAtMs, source: 'manual' });
const mash = (id: string, hitAtMs: number, durationMs: number): ChartNote => ({ id, hitAtMs, source: 'manual', type: 'mash', durationMs });

describe('連打（mash）', () => {
  it('終了時刻・必要回数・判定', () => {
    expect(noteEndMs(tap('a', 1000))).toBe(1000);
    expect(noteEndMs(mash('m', 1000, 800))).toBe(1800);
    expect(mashRequiredPresses(800)).toBe(4);
    expect(mashRequiredPresses(50)).toBe(1);
    expect(judgeMash(4, 800)).toBe('PERFECT');
    expect(judgeMash(2, 800)).toBe('GOOD');
    expect(judgeMash(1, 800)).toBe('BAD');
    expect(judgeMash(0, 800)).toBe('MISS');
    expect(isInMashSpan(1000 - MASH.edgeToleranceMs, 1000, 800)).toBe(true);
    expect(isInMashSpan(1800 + MASH.edgeToleranceMs + 1, 1000, 800)).toBe(false);
  });

  it('難易度間判定は連打の区間全体を占有として扱う', () => {
    const levels = { '1': { notes: [mash('m', 1000, 1000)] }, '2': { notes: [] }, '3': { notes: [] }, '4': { notes: [] } };
    expect(findNearestCrossLevelConflict(1500, 2, levels)).toMatchObject({ id: 'm', diffMs: 0 });
    expect(findNearestCrossLevelConflict(2080, 2, levels)).toMatchObject({ id: 'm', diffMs: 80 });
    expect(findNearestCrossLevelConflict(2081, 2, levels)).toBeNull();
    expect(findNearestCrossLevelConflict(919, 2, levels)).toBeNull();
    // 候補が区間の場合
    expect(findNearestCrossLevelConflict(2100, 2, levels, 80, undefined, 500)).toBeNull();
    expect(findNearestCrossLevelConflict(300, 2, levels, 80, undefined, 700)).toMatchObject({ id: 'm', diffMs: 0 });
    const used = usedTimesOf(levels);
    expect(used[0]).toMatchObject({ level: 1, hitAtMs: 1000, durationMs: 1000 });
    expect(conflictsWithOtherLevel(1900, 2, used)).toBe(true);
    expect(conflictsWithOtherLevel(2081, 2, used)).toBe(false);
    const report = findCrossLevelConflicts({ ...levels, '3': { notes: [tap('t', 1500), tap('u', 2081), tap('v', 2080)] } });
    expect(report.countsByPair['1-3']).toBe(2);
  });

  it('validateChart は連打の長さ・範囲・区間内の重複を検証し、最小間隔は終了時刻から測る', () => {
    const chart = sampleChart();
    chart.levels['1'].notes = [mash('m', 1000, 1000), tap('t', 1700)];
    let r = validateChart(chart);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'mash-overlap')).toBe(true);
    chart.levels['1'].notes = [{ ...mash('m', 1000, 100) }];
    expect(validateChart(chart).ok).toBe(false); // 200ms 未満
    chart.levels['1'].notes = [mash('m', 179500, 1000)];
    expect(validateChart(chart).ok).toBe(false); // 終了が範囲外
    chart.levels['1'].notes = [mash('m', 1000, 1000), tap('t', 2300)];
    r = validateChart(chart, { minGapMsByLevel: { '1': 600 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.code === 'note-min-gap')).toBe(true); // 2000 → 2300 は 300ms
    chart.levels['1'].notes = [mash('m', 1000, 1000), tap('t', 2700)];
    r = validateChart(chart, { minGapMsByLevel: { '1': 600 } });
    expect(r.ok && r.warnings.every((w) => w.code !== 'note-min-gap')).toBe(true);
    if (r.ok) expect(r.chart.levels['1'].notes[0]).toMatchObject({ type: 'mash', durationMs: 1000 });
  });
});
