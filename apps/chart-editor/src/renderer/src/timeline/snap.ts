import type { AnalysisResult } from '@autobeats/audio-analysis';

export type SnapTarget = 'beat' | 'half' | 'quarter' | 'onset';

/** スナップ対象のグリッド（昇順）を作る */
export function buildSnapGrid(analysis: Pick<AnalysisResult, 'beats' | 'onsets'> | null, target: SnapTarget, bpm: number, offsetMs: number, durationMs: number): number[] {
  if (target === 'onset') return analysis ? analysis.onsets.map((o) => o.timeMs) : [];
  let beats = analysis?.beats ?? [];
  if (beats.length < 2 && bpm > 0) {
    beats = [];
    const beatMs = 60000 / bpm;
    for (let t = offsetMs; t < durationMs; t += beatMs) beats.push(Math.round(t));
  }
  const div = target === 'beat' ? 1 : target === 'half' ? 2 : 4;
  if (div === 1) return beats;
  const out: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    const a = beats[i]!;
    const b = beats[i + 1];
    out.push(a);
    if (b !== undefined) for (let d = 1; d < div; d++) out.push(Math.round(a + ((b - a) * d) / div));
  }
  return out;
}

/** 最も近いグリッド点を返す。グリッドが空なら入力をそのまま返す */
export function snapToGrid(ms: number, grid: readonly number[], maxDistanceMs = Infinity): number {
  if (grid.length === 0) return Math.round(ms);
  let lo = 0;
  let hi = grid.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid]! < ms) lo = mid + 1;
    else hi = mid;
  }
  let best = grid[lo]!;
  if (lo > 0 && Math.abs(grid[lo - 1]! - ms) < Math.abs(best - ms)) best = grid[lo - 1]!;
  return Math.abs(best - ms) <= maxDistanceMs ? best : Math.round(ms);
}
