import { describe, expect, it } from 'vitest';
import { CROSS_LEVEL_EXCLUSION_MS, conflictsWithOtherLevel, findCrossLevelConflicts, findNearestCrossLevelConflict, isCrossLevelConflict, usedTimesOf, validateChart, type ChartNote, type UsedNoteTime } from '../src';
import { sampleChart } from './validate.test';

const note = (id: string, hitAtMs: number): ChartNote => ({ id, hitAtMs, source: 'generated' });

describe('難易度間衝突判定', () => {
  it('既定の除外幅は 80ms', () => {
    expect(CROSS_LEVEL_EXCLUSION_MS).toBe(80);
  });
  it('完全一致・1ms・79ms・80ms は衝突、81ms は非衝突（境界を含む）', () => {
    expect(isCrossLevelConflict(1000, 1000)).toBe(true);
    expect(isCrossLevelConflict(1000, 1001)).toBe(true);
    expect(isCrossLevelConflict(1000, 1079)).toBe(true);
    expect(isCrossLevelConflict(1000, 1080)).toBe(true);
    expect(isCrossLevelConflict(1000, 920)).toBe(true);
    expect(isCrossLevelConflict(1000, 1081)).toBe(false);
    expect(isCrossLevelConflict(1000, 919)).toBe(false);
  });
  it('同じレベルの音符は難易度間衝突として扱わない', () => {
    const used: UsedNoteTime[] = [{ level: 2, hitAtMs: 1000 }];
    expect(conflictsWithOtherLevel(1000, 2, used)).toBe(false);
    expect(conflictsWithOtherLevel(1000, 1, used)).toBe(true);
    expect(conflictsWithOtherLevel(1081, 1, used)).toBe(false);
  });
  it('最も近い衝突相手を返し、除外 ID を無視する', () => {
    const levels = {
      '1': { notes: [note('a', 1000)] },
      '2': { notes: [note('b', 1050)] },
      '3': { notes: [] },
      '4': { notes: [note('c', 1070)] },
    };
    expect(findNearestCrossLevelConflict(1060, 3, levels)).toMatchObject({ level: 2, id: 'b', diffMs: 10 });
    expect(findNearestCrossLevelConflict(1060, 3, levels, 80, new Set(['b']))).toMatchObject({ level: 4, id: 'c', diffMs: 10 });
    expect(findNearestCrossLevelConflict(1060, 2, levels)).toMatchObject({ level: 4, id: 'c' });
    expect(findNearestCrossLevelConflict(5000, 1, levels)).toBeNull();
  });
  it('全組み合わせの衝突を数える', () => {
    const levels = {
      '1': { notes: [note('a1', 1000), note('a2', 5000)] },
      '2': { notes: [note('b1', 1040), note('b2', 9000)] },
      '3': { notes: [note('c1', 1081), note('c2', 5080)] },
      '4': { notes: [note('d1', 9000)] },
    };
    const r = findCrossLevelConflicts(levels);
    expect(r.countsByPair['1-2']).toBe(1);
    expect(r.countsByPair['1-3']).toBe(1);
    expect(r.countsByPair['1-4']).toBe(0);
    expect(r.countsByPair['2-3']).toBe(1);
    expect(r.countsByPair['2-4']).toBe(1);
    expect(r.countsByPair['3-4']).toBe(0);
    expect(r.total).toBe(4);
    expect(usedTimesOf(levels)).toHaveLength(7);
    expect(usedTimesOf(levels, [1, 2])).toHaveLength(4);
  });
  it('validateChart はオプション指定時だけ難易度間衝突をエラーにし、全件列挙する', () => {
    const chart = sampleChart();
    chart.levels['1'].notes = [note('a1', 1000), note('a2', 3000)];
    chart.levels['2'].notes = [note('b1', 1050), note('b2', 3080)];
    chart.levels['3'].notes = [note('c1', 2000)];
    expect(validateChart(chart).ok).toBe(true);
    const r = validateChart(chart, { crossLevelExclusionMs: 80 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.filter((e) => e.code === 'cross-level')).toHaveLength(2);
    chart.levels['2'].notes = [note('b1', 1081), note('b2', 3081)];
    expect(validateChart(chart, { crossLevelExclusionMs: 80 }).ok).toBe(true);
  });
  it('minGapAsError で最小間隔違反をエラーにできる', () => {
    const chart = sampleChart();
    chart.levels['1'].notes = [note('a1', 1000), note('a2', 1100)];
    expect(validateChart(chart, { minGapMsByLevel: { '1': 600 } }).ok).toBe(true);
    expect(validateChart(chart, { minGapMsByLevel: { '1': 600 }, minGapAsError: true }).ok).toBe(false);
  });
  it('generationRules を保持し、無くても読める', () => {
    const chart = { ...sampleChart(), generationRules: { crossLevelExclusionMs: 80, levelPriority: [1, 2, 3, 4], crossLevelNotesAreExclusive: true } };
    const r = validateChart(chart);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chart.generationRules?.crossLevelExclusionMs).toBe(80);
    expect(validateChart(sampleChart()).ok).toBe(true);
  });
});
