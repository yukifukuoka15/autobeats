import { describe, expect, it } from 'vitest';
import { generateLevelDetailed, type GenerationAnalysis } from '../src/generate';
import { DEFAULT_LEVEL_SETTINGS, type ChartNote } from '@autobeats/chart-format';

const beats = Array.from({ length: 64 }, (_, i) => i * 500);
const analysis: GenerationAnalysis = { beats, downbeats: beats.filter((_, i) => i % 4 === 0), onsets: beats.map(t => ({ timeMs: t, strength: 0.8 })), bpm: 120, beatsPerBar: 4, leadInEndMs: 0, tailStartMs: 32000, energyCurve: Array.from({ length: 320 }, (_, i) => i < 80 ? 0.04 : 0.8), energyCurveStepMs: 100 };

describe('追加譜面のフレーズと累積密度', () => {
  it('静かな導入は休み、全体が小音量でも音量比が同じなら同じ配置にする', () => {
    const input = { analysis, choruses: [], durationMs: 32000, musicalPhrasing: true };
    const r = generateLevelDetailed(1, input);
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.notes.every(n => n.hitAtMs >= 8000)).toBe(true);
    const quieter = { ...analysis, energyCurve: analysis.energyCurve!.map(e => e * 0.01) };
    expect(generateLevelDetailed(1, { ...input, analysis: quieter }).notes).toEqual(r.notes);
  });
  it('下位譜面を含めた小節の上限を超えず、80ms以内の打点を追加しない', () => {
    const lower: ChartNote[] = [8000, 8500, 10000, 10500].map((hitAtMs, i) => ({ id: `base-${i}`, hitAtMs, source: 'manual' }));
    const r = generateLevelDetailed(2, { analysis, choruses: [], durationMs: 32000, musicalPhrasing: true, cumulativeBase: lower, usedTimes: lower.map(n => ({ level: 1, hitAtMs: n.hitAtMs })), settings: { 2: { ...DEFAULT_LEVEL_SETTINGS[2], density: 1 } } });
    for (const n of r.notes) expect(lower.every(b => Math.abs(n.hitAtMs - b.hitAtMs) > 80)).toBe(true);
    // 8〜10秒の小節と10〜12秒の小節は下位譜面だけで上限2打に達している。
    expect(r.notes.some(n => n.hitAtMs >= 8000 && n.hitAtMs < 12000)).toBe(false);
  });
  it('音量特徴がない旧解析結果でも生成でき、元データを変更しない', () => {
    const { energyCurve: _energy, energyCurveStepMs: _step, ...legacy } = analysis;
    const before = JSON.stringify(legacy);
    expect(generateLevelDetailed(1, { analysis: legacy, choruses: [], durationMs: 32000, musicalPhrasing: true }).notes.length).toBeGreaterThan(0);
    expect(JSON.stringify(legacy)).toBe(before);
  });
});
