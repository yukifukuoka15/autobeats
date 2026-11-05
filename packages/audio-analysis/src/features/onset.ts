import { movingAverage, percentile } from '../dsp/filters';
import type { DetectedOnset } from '../types';

export interface OnsetEnvelope {
  /** 0～1 へ正規化済みのオンセット包絡（フレーム単位） */
  envelope: Float32Array;
  hopMs: number;
}

/** スペクトルフラックスから正規化オンセット包絡を作る */
export function buildOnsetEnvelope(flux: Float32Array, hopMs: number): OnsetEnvelope {
  const n = flux.length;
  const env = new Float32Array(n);
  if (n === 0) return { envelope: env, hopMs };
  // 局所平均を引いて半波整流（ゆっくりした変化を除去）
  const local = movingAverage(flux, Math.round(1000 / hopMs));
  for (let i = 0; i < n; i++) env[i] = Math.max(0, flux[i]! - local[i]! * 0.5);
  const robustMax = percentile(env, 0.995);
  const scale = robustMax > 1e-9 ? 1 / robustMax : 0;
  for (let i = 0; i < n; i++) env[i] = Math.min(1, env[i]! * scale);
  return { envelope: env, hopMs };
}

export interface OnsetPickOptions {
  /** 最小オンセット間隔 */
  minIntervalMs?: number;
  /** 局所平均に加える閾値 */
  delta?: number;
}

/** 適応閾値によるピーク検出 */
export function pickOnsets(env: OnsetEnvelope, options: OnsetPickOptions = {}): DetectedOnset[] {
  const { envelope, hopMs } = env;
  const n = envelope.length;
  const minInterval = Math.max(1, Math.round((options.minIntervalMs ?? 50) / hopMs));
  const delta = options.delta ?? 0.07;
  const pre = Math.round(100 / hopMs);
  const post = Math.round(30 / hopMs);
  const meanWin = movingAverage(envelope, Math.round(150 / hopMs));
  const result: DetectedOnset[] = [];
  let lastPick = -Infinity;
  for (let t = 1; t < n - 1; t++) {
    const v = envelope[t]!;
    if (v < delta) continue;
    let isMax = true;
    for (let j = Math.max(0, t - pre); j <= Math.min(n - 1, t + post); j++) {
      if (envelope[j]! > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    if (v < meanWin[t]! + delta) continue;
    if (t - lastPick < minInterval) {
      // 近接ピークは強い方を残す
      const last = result[result.length - 1];
      if (last && v > last.strength) {
        result[result.length - 1] = { timeMs: Math.round(t * hopMs), strength: v };
        lastPick = t;
      }
      continue;
    }
    result.push({ timeMs: Math.round(t * hopMs), strength: Math.min(1, v) });
    lastPick = t;
  }
  return result;
}
