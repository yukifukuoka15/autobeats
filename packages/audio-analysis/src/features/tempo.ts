import { parabolicPeak } from '../dsp/filters';
import { BPM_RANGE } from '@autobeats/chart-format';

export interface TempoEstimate {
  bpm: number;
  /** 拍周期（フレーム数、小数） */
  periodFrames: number;
  /** 0～1 */
  confidence: number;
  /** 候補一覧（上位） */
  candidates: { bpm: number; score: number }[];
}

function tempoPrior(bpm: number, centerBpm: number, widthOctaves: number): number {
  const x = Math.log2(bpm / centerBpm) / widthOctaves;
  return Math.exp(-0.5 * x * x);
}

/**
 * オンセット包絡の自己相関（テンポグラム集約）から BPM を推定する。
 * 数秒窓ごとの自己相関を合算して局所的な変動に強くし、対数正規の事前分布で倍・半テンポの曖昧さを抑える。
 */
export function estimateTempo(envelope: Float32Array, hopMs: number, options: { minBpm?: number; maxBpm?: number; priorBpm?: number } = {}): TempoEstimate {
  const fps = 1000 / hopMs;
  const minBpm = options.minBpm ?? Math.max(BPM_RANGE.min, 50);
  const maxBpm = options.maxBpm ?? Math.min(BPM_RANGE.max, 240);
  const priorBpm = options.priorBpm ?? 118;
  const minLag = Math.max(2, Math.floor((60 / maxBpm) * fps));
  const maxLag = Math.ceil((60 / minBpm) * fps);
  const n = envelope.length;
  const empty: TempoEstimate = { bpm: 120, periodFrames: (60 / 120) * fps, confidence: 0, candidates: [] };
  if (n < maxLag * 3) return empty;

  // テンポグラム: 窓ごとの自己相関を合算
  const winLen = Math.min(n, Math.round(fps * 12));
  const hop = Math.max(1, Math.round(winLen / 2));
  const ac = new Float64Array(maxLag + 1);
  let windows = 0;
  for (let start = 0; start + winLen <= n; start += hop) {
    let m = 0;
    for (let i = 0; i < winLen; i++) m += envelope[start + i]!;
    m /= winLen;
    let energy = 0;
    for (let i = 0; i < winLen; i++) {
      const d = envelope[start + i]! - m;
      energy += d * d;
    }
    if (energy < 1e-9) continue;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < winLen; i++) s += (envelope[start + i]! - m) * (envelope[start + i + lag]! - m);
      ac[lag] = ac[lag]! + s / energy;
    }
    windows++;
  }
  if (windows === 0) return empty;

  // 事前分布で重み付け
  const weighted = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    weighted[lag] = Math.max(0, ac[lag]! / windows) * tempoPrior(bpm, priorBpm, 1.0);
  }
  // 倍テンポ・半テンポの整合: lag と 2lag の両方が強いなら lag を優先しやすくする
  const combined = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let v = weighted[lag]!;
    if (lag * 2 <= maxLag) v += 0.5 * weighted[lag * 2]!;
    const half = lag / 2;
    if (Number.isInteger(half) && half >= minLag) v += 0.25 * weighted[half]!;
    combined[lag] = v;
  }
  const peaks: { lag: number; score: number }[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (combined[lag]! > combined[lag - 1]! && combined[lag]! >= combined[lag + 1]!) peaks.push({ lag, score: combined[lag]! });
  }
  if (peaks.length === 0) return empty;
  peaks.sort((a, b) => b.score - a.score);
  const best = peaks[0]!;
  // 小数ラグは事前分布の影響を受けない生の自己相関で補間する
  const refined = parabolicPeak(ac, best.lag);
  const periodFrames = Math.abs(refined.position - best.lag) < 1 ? refined.position : best.lag;
  const bpm = (60 * fps) / periodFrames;
  const second = peaks[1]?.score ?? 0;
  const confidence = Math.max(0, Math.min(1, best.score > 0 ? (best.score - second) / best.score + 0.3 * Math.min(1, best.score) : 0));
  return {
    bpm,
    periodFrames,
    confidence,
    candidates: peaks.slice(0, 5).map((p) => ({ bpm: (60 * fps) / p.lag, score: p.score })),
  };
}
