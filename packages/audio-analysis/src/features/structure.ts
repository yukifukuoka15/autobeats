import type { ChorusSection } from '@autobeats/chart-format';
import { movingAverage } from '../dsp/filters';
import type { DetectedSection } from '../types';
import { chromaAt, type FrameFeatures } from './frames';

/** 拍同期特徴（unit = 連続する k 拍の平均） */
export interface BeatSyncFeatures {
  unitCount: number;
  beatsPerUnit: number;
  /** 各 unit の開始フレーム */
  startFrames: number[];
  /** 各 unit の終了フレーム（排他的） */
  endFrames: number[];
  /** 16 次元 × unitCount（chroma 12 + 音色 4） */
  vectors: Float32Array;
  rms: Float32Array;
  centroid: Float32Array;
}

export const FEATURE_DIM = 16;

export function buildBeatSyncFeatures(beatFrames: number[], features: FrameFeatures, envelope: Float32Array, maxUnits = 1500): BeatSyncFeatures {
  const nBeats = beatFrames.length;
  const beatsPerUnit = Math.max(1, Math.ceil(nBeats / maxUnits));
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < nBeats; i += beatsPerUnit) {
    const s = beatFrames[i]!;
    const e = i + beatsPerUnit < nBeats ? beatFrames[i + beatsPerUnit]! : features.frameCount;
    if (e > s) {
      starts.push(s);
      ends.push(e);
    }
  }
  const unitCount = starts.length;
  const vectors = new Float32Array(unitCount * FEATURE_DIM);
  const rms = new Float32Array(unitCount);
  const centroid = new Float32Array(unitCount);
  let rmsMax = 1e-9;
  let lowMax = 1e-9;
  for (let t = 0; t < features.frameCount; t++) {
    if (features.rms[t]! > rmsMax) rmsMax = features.rms[t]!;
    if (features.low[t]! > lowMax) lowMax = features.low[t]!;
  }
  const rawChroma = new Float32Array(unitCount * 12);
  const timbre = new Float32Array(unitCount * 4);
  for (let u = 0; u < unitCount; u++) {
    const s = starts[u]!;
    const e = ends[u]!;
    const len = e - s;
    let r = 0;
    let c = 0;
    let lo = 0;
    let on = 0;
    let chromaFrames = 0;
    for (let t = s; t < e; t++) {
      if (t % features.chromaStride === 0 || t === s) {
        const cv = chromaAt(features, t);
        for (let k = 0; k < 12; k++) rawChroma[u * 12 + k] = rawChroma[u * 12 + k]! + cv[k]!;
        chromaFrames++;
      }
      r += features.rms[t]!;
      c += features.centroid[t]!;
      lo += features.low[t]!;
      on += envelope[t] ?? 0;
    }
    void chromaFrames;
    rms[u] = r / len / rmsMax;
    centroid[u] = c / len;
    timbre[u * 4] = Math.sqrt(rms[u]!);
    timbre[u * 4 + 1] = Math.sqrt(Math.min(1, lo / len / lowMax));
    timbre[u * 4 + 2] = Math.min(1, centroid[u]! * 4);
    timbre[u * 4 + 3] = Math.min(1, on / len);
  }
  // chroma を約1小節で平滑化（セクション内の和音進行による揺れを抑える）
  const radius = Math.max(1, Math.round(2 / beatsPerUnit));
  for (let u = 0; u < unitCount; u++) {
    const a = Math.max(0, u - radius);
    const b = Math.min(unitCount - 1, u + radius);
    let norm = 0;
    for (let k = 0; k < 12; k++) {
      let sum = 0;
      for (let v = a; v <= b; v++) sum += rawChroma[v * 12 + k]!;
      vectors[u * FEATURE_DIM + k] = sum;
      norm += sum * sum;
    }
    norm = Math.sqrt(norm);
    for (let k = 0; k < 12; k++) vectors[u * FEATURE_DIM + k] = norm > 1e-9 ? vectors[u * FEATURE_DIM + k]! / norm : 0;
  }
  // 音色・音量特徴は曲全体で標準化し、chroma（ノルム1）と同程度のスケールにする
  for (let f = 0; f < 4; f++) {
    let m = 0;
    for (let u = 0; u < unitCount; u++) m += timbre[u * 4 + f]!;
    m /= Math.max(1, unitCount);
    let v = 0;
    for (let u = 0; u < unitCount; u++) v += (timbre[u * 4 + f]! - m) ** 2;
    const sd = Math.sqrt(v / Math.max(1, unitCount));
    for (let u = 0; u < unitCount; u++) {
      const z = sd > 1e-6 ? (timbre[u * 4 + f]! - m) / sd : 0;
      vectors[u * FEATURE_DIM + 12 + f] = Math.max(-3, Math.min(3, z)) * 0.5;
    }
  }
  return { unitCount, beatsPerUnit, startFrames: starts, endFrames: ends, vectors, rms, centroid };
}

/** ガウス RBF による自己類似行列（unitCount × unitCount）。σ² は距離の中央値から決める */
export function selfSimilarity(bs: BeatSyncFeatures): Float32Array {
  const n = bs.unitCount;
  const ssm = new Float32Array(n * n);
  const dist2 = new Float32Array(n * n);
  const samples: number[] = [];
  const sampleStep = Math.max(1, Math.floor((n * n) / 4000));
  let idx = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let d = 0;
      for (let k = 0; k < FEATURE_DIM; k++) {
        const diff = bs.vectors[i * FEATURE_DIM + k]! - bs.vectors[j * FEATURE_DIM + k]!;
        d += diff * diff;
      }
      dist2[i * n + j] = d;
      dist2[j * n + i] = d;
      if (idx++ % sampleStep === 0) samples.push(d);
    }
  }
  samples.sort((a, b) => a - b);
  const sigma2 = Math.max(1e-6, samples[Math.floor(samples.length / 2)] ?? 1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) ssm[i * n + j] = i === j ? 1 : Math.exp(-dist2[i * n + j]! / (2 * sigma2));
  }
  return ssm;
}

/** Foote のチェッカーボードカーネルによるノベルティ曲線 */
export function noveltyCurve(ssm: Float32Array, n: number, kernelHalf: number): Float32Array {
  const nov = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    let cnt = 0;
    for (let a = -kernelHalf; a < kernelHalf; a++) {
      const i = t + a;
      if (i < 0 || i >= n) continue;
      for (let b = -kernelHalf; b < kernelHalf; b++) {
        const j = t + b;
        if (j < 0 || j >= n) continue;
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        const w = Math.exp(-0.5 * ((a + 0.5) ** 2 + (b + 0.5) ** 2) / (kernelHalf * kernelHalf * 0.5));
        s += sign * w * ssm[i * n + j]!;
        cnt++;
      }
    }
    nov[t] = cnt > 0 ? s / cnt : 0;
  }
  // 端はカーネルが外へはみ出して偽のピークになるため無視する
  for (let t = 0; t < n; t++) if (t < kernelHalf || t >= n - kernelHalf) nov[t] = 0;
  let max = 1e-9;
  for (let t = 0; t < n; t++) if (nov[t]! > max) max = nov[t]!;
  for (let t = 0; t < n; t++) nov[t] = Math.max(0, nov[t]! / max);
  return nov;
}

export interface SegmentUnits {
  startUnit: number;
  endUnit: number;
}

/** ノベルティのピークから境界を求め、小節頭 unit へ吸着させる */
export function segmentByNovelty(nov: Float32Array, downbeatUnits: Set<number>, minUnits: number): SegmentUnits[] {
  const n = nov.length;
  if (n === 0) return [];
  const smooth = movingAverage(nov, 1);
  const boundaries = new Set<number>([0]);
  const local = movingAverage(smooth, Math.max(2, minUnits));
  const peaks: { t: number; v: number }[] = [];
  for (let t = 1; t < n - 1; t++) {
    if (smooth[t]! > smooth[t - 1]! && smooth[t]! >= smooth[t + 1]! && smooth[t]! > local[t]! + 0.05 && smooth[t]! > 0.15) {
      peaks.push({ t, v: smooth[t]! });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const chosen: number[] = [];
  for (const p of peaks) {
    // 最も近い小節頭へ吸着
    let best = p.t;
    let bestDist = Infinity;
    for (const d of downbeatUnits) {
      const dist = Math.abs(d - p.t);
      if (dist < bestDist && dist <= 2) {
        bestDist = dist;
        best = d;
      }
    }
    if (chosen.every((c) => Math.abs(c - best) >= minUnits) && best >= minUnits && n - best >= minUnits) chosen.push(best);
  }
  for (const c of chosen) boundaries.add(c);
  const sorted = [...boundaries].sort((a, b) => a - b);
  const segs: SegmentUnits[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    const e = i + 1 < sorted.length ? sorted[i + 1]! : n;
    if (e > s) segs.push({ startUnit: s, endUnit: e });
  }
  return segs;
}

/** 2つの区間の類似度（短い方の長さで対角平均） */
function segmentSimilarity(ssm: Float32Array, n: number, a: SegmentUnits, b: SegmentUnits): number {
  const len = Math.min(a.endUnit - a.startUnit, b.endUnit - b.startUnit);
  if (len <= 0) return 0;
  let s = 0;
  for (let k = 0; k < len; k++) s += ssm[(a.startUnit + k) * n + (b.startUnit + k)]!;
  return s / len;
}

export interface StructureResult {
  sections: DetectedSection[];
  choruses: ChorusSection[];
}

export interface StructureOptions {
  durationMs: number;
  hopMs: number;
  /** サビ候補の最大数 */
  maxChoruses?: number;
}

/**
 * セクション分割とサビ候補推定。
 * 各セクションに反復性（他セクションとの最大類似度）、エネルギー、明るさ、位置・長さ事前分布を合成したスコアを付け、
 * 最高スコアのクラスタに属するセクションをサビ候補として返す。
 */
export function analyzeStructure(bs: BeatSyncFeatures, downbeatUnits: Set<number>, options: StructureOptions): StructureResult {
  const n = bs.unitCount;
  const unitMs = (f: number) => Math.round(f * options.hopMs);
  if (n < 8) {
    return { sections: [], choruses: [] };
  }
  const ssm = selfSimilarity(bs);
  const unitSec = ((bs.endFrames[0]! - bs.startFrames[0]!) * options.hopMs) / 1000;
  // カーネル半幅 ≒ 4 秒、最小区間 ≒ 5 秒
  const kernelHalf = Math.max(2, Math.round(4 / Math.max(0.1, unitSec)));
  const minUnits = Math.max(2, Math.round(5 / Math.max(0.1, unitSec)));
  const nov = noveltyCurve(ssm, n, kernelHalf);
  let segs = segmentByNovelty(nov, downbeatUnits, minUnits);
  // 長すぎる区間は 16 小節程度で分割する（サビ候補の粒度確保）
  const maxUnits = Math.max(minUnits * 2, Math.round(32 / Math.max(0.1, unitSec)));
  segs = segs.flatMap((s) => {
    const len = s.endUnit - s.startUnit;
    if (len <= maxUnits) return [s];
    const parts = Math.ceil(len / maxUnits);
    const out: SegmentUnits[] = [];
    for (let p = 0; p < parts; p++) {
      const a = s.startUnit + Math.round((len * p) / parts);
      const b = s.startUnit + Math.round((len * (p + 1)) / parts);
      if (b > a) out.push({ startUnit: a, endUnit: b });
    }
    return out;
  });

  const m = segs.length;
  const rep = new Float64Array(m);
  const sim = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      if (i === j) continue;
      const v = segmentSimilarity(ssm, n, segs[i]!, segs[j]!);
      sim[i * m + j] = v;
    }
  }
  for (let i = 0; i < m; i++) {
    const others: number[] = [];
    for (let j = 0; j < m; j++) if (i !== j) others.push(sim[i * m + j]!);
    others.sort((a, b) => b - a);
    rep[i] = others.length > 0 ? (others[0]! + (others[1] ?? others[0]!)) / 2 : 0;
  }
  const energy = new Float64Array(m);
  const bright = new Float64Array(m);
  let eMax = 1e-9;
  let bMax = 1e-9;
  for (let i = 0; i < m; i++) {
    const s = segs[i]!;
    let e = 0;
    let b = 0;
    for (let u = s.startUnit; u < s.endUnit; u++) {
      e += bs.rms[u]!;
      b += bs.centroid[u]!;
    }
    energy[i] = e / (s.endUnit - s.startUnit);
    bright[i] = b / (s.endUnit - s.startUnit);
    if (energy[i]! > eMax) eMax = energy[i]!;
    if (bright[i]! > bMax) bMax = bright[i]!;
  }
  // クラスタリング（類似度 0.72 以上を同じクラスタに）
  const cluster = new Int32Array(m).fill(-1);
  let nextCluster = 0;
  for (let i = 0; i < m; i++) {
    if (cluster[i] !== -1) continue;
    cluster[i] = nextCluster;
    for (let j = i + 1; j < m; j++) {
      if (cluster[j] === -1 && sim[i * m + j]! >= 0.72) cluster[j] = nextCluster;
    }
    nextCluster++;
  }
  const scores = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const s = segs[i]!;
    const startMs = unitMs(bs.startFrames[s.startUnit]!);
    const endMs = unitMs(bs.endFrames[s.endUnit - 1]!);
    const lenSec = (endMs - startMs) / 1000;
    const pos = startMs / Math.max(1, options.durationMs);
    const positionPrior = pos < 0.08 ? 0.3 : pos > 0.97 ? 0.5 : 1;
    const lengthPrior = lenSec < 8 ? 0.4 : lenSec > 60 ? 0.6 : 1;
    scores[i] =
      (0.45 * rep[i]! + 0.35 * (energy[i]! / eMax) + 0.1 * (bright[i]! / bMax) + 0.1) * positionPrior * lengthPrior;
  }
  // クラスタごとの平均スコア（単独クラスタは反復性がないので減点）
  const clusterScore = new Map<number, { sum: number; count: number }>();
  for (let i = 0; i < m; i++) {
    const c = cluster[i]!;
    const cur = clusterScore.get(c) ?? { sum: 0, count: 0 };
    cur.sum += scores[i]!;
    cur.count++;
    clusterScore.set(c, cur);
  }
  let bestCluster = -1;
  let bestScore = -Infinity;
  for (const [c, v] of clusterScore) {
    const avg = (v.sum / v.count) * (v.count >= 2 ? 1 : 0.7);
    if (avg > bestScore) {
      bestScore = avg;
      bestCluster = c;
    }
  }
  const sections: DetectedSection[] = segs.map((s, i) => ({
    startMs: unitMs(bs.startFrames[s.startUnit]!),
    endMs: Math.min(options.durationMs, unitMs(bs.endFrames[s.endUnit - 1]!)),
    cluster: cluster[i]!,
    energy: Math.min(1, energy[i]! / eMax),
    repetition: Math.max(0, Math.min(1, rep[i]!)),
  }));
  const maxChoruses = options.maxChoruses ?? 6;
  const chorusSegs = sections
    .map((sec, i) => ({ sec, i, score: scores[i]! }))
    .filter((x) => cluster[x.i] === bestCluster)
    .sort((a, b) => a.sec.startMs - b.sec.startMs);
  // 隣接する同クラスタ区間は結合
  const merged: { startMs: number; endMs: number; score: number }[] = [];
  for (const x of chorusSegs) {
    const last = merged[merged.length - 1];
    if (last && x.sec.startMs <= last.endMs + 1) {
      last.endMs = x.sec.endMs;
      last.score = Math.max(last.score, x.score);
    } else merged.push({ startMs: x.sec.startMs, endMs: x.sec.endMs, score: x.score });
  }
  const maxScore = Math.max(1e-9, ...merged.map((x) => x.score));
  const choruses: ChorusSection[] = merged
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChoruses)
    .sort((a, b) => a.startMs - b.startMs)
    .map((x, idx) => ({
      id: `chorus-${idx + 1}`,
      startMs: x.startMs,
      endMs: x.endMs,
      confidence: Math.max(0.05, Math.min(0.99, 0.35 + 0.6 * (x.score / maxScore) * Math.min(1, bestScore))),
      source: 'detected' as const,
    }))
    .filter((c) => c.endMs > c.startMs);
  return { sections, choruses };
}
