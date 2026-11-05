import { chromaAt, type FrameFeatures } from './frames';

export interface DownbeatEstimate {
  beatsPerBar: number;
  /** 小節頭となる拍の位相（0..beatsPerBar-1） */
  phase: number;
  downbeatIndices: number[];
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na < 1e-12 || nb < 1e-12) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 4/4 を前提に、各拍のアクセント（低域の立ち上がり、オンセット強度、和声変化）を位相別に集計し、
 * 最も強い位相を小節頭とする。
 */
export function estimateDownbeats(beatFrames: number[], features: FrameFeatures, envelope: Float32Array, beatsPerBar = 4): DownbeatEstimate {
  const n = beatFrames.length;
  if (n === 0) return { beatsPerBar, phase: 0, downbeatIndices: [] };
  const accents = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = beatFrames[i]!;
    const prevF = i > 0 ? beatFrames[i - 1]! : Math.max(0, f - 1);
    const lowNow = features.low[Math.min(features.frameCount - 1, f)] ?? 0;
    const lowPrev = features.low[Math.min(features.frameCount - 1, Math.max(0, f - 2))] ?? 0;
    const lowRise = Math.max(0, lowNow - lowPrev);
    const onset = envelope[Math.min(envelope.length - 1, f)] ?? 0;
    const chromaChange = 1 - cosineSim(chromaAt(features, f), chromaAt(features, prevF));
    accents[i] = lowRise * 2 + onset + chromaChange * 1.5;
  }
  const sums = new Float64Array(beatsPerBar);
  for (let i = 0; i < n; i++) sums[i % beatsPerBar] = sums[i % beatsPerBar]! + accents[i]!;
  let phase = 0;
  for (let p = 1; p < beatsPerBar; p++) if (sums[p]! > sums[phase]!) phase = p;
  const downbeatIndices: number[] = [];
  for (let i = phase; i < n; i += beatsPerBar) downbeatIndices.push(i);
  return { beatsPerBar, phase, downbeatIndices };
}
