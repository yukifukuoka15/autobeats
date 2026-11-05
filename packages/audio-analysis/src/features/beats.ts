import { std } from '../dsp/filters';

/**
 * 動的計画法による拍追跡（Ellis 2007 方式）。
 * 推定周期からの逸脱に対数二乗ペナルティを与え、オンセット包絡の累積スコアを最大化する。
 * 戻り値はフレーム番号（小数なし）。
 */
export function trackBeats(envelope: Float32Array, periodFrames: number, tightness = 100): number[] {
  const n = envelope.length;
  if (n === 0 || periodFrames < 1) return [];
  const sd = std(envelope);
  const scale = sd > 1e-9 ? 1 / sd : 1;
  // 周期の 1/32 幅のガウスで平滑化した局所スコア
  const gw = Math.max(1, Math.round(periodFrames / 32));
  const kernel: number[] = [];
  for (let k = -gw * 3; k <= gw * 3; k++) kernel.push(Math.exp(-0.5 * (k / gw) ** 2));
  const local = new Float64Array(n);
  const half = Math.floor(kernel.length / 2);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = 0; k < kernel.length; k++) {
      const idx = t + k - half;
      if (idx >= 0 && idx < n) s += envelope[idx]! * kernel[k]!;
    }
    local[t] = s * scale;
  }

  const windowStart = -Math.round(2 * periodFrames);
  const windowEnd = -Math.round(periodFrames / 2);
  const txwt = new Float64Array(windowEnd - windowStart + 1);
  for (let i = 0; i < txwt.length; i++) {
    const delta = -(windowStart + i);
    txwt[i] = -tightness * Math.log(delta / periodFrames) ** 2;
  }

  const cumscore = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  let firstBeatRange = true;
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < txwt.length; i++) {
      const prev = t + windowStart + i;
      if (prev < 0) continue;
      const v = cumscore[prev]! + txwt[i]!;
      if (v > best) {
        best = v;
        bestIdx = prev;
      }
    }
    if (bestIdx === -1) {
      cumscore[t] = local[t]!;
      backlink[t] = -1;
    } else {
      cumscore[t] = local[t]! + best;
      backlink[t] = bestIdx;
      if (firstBeatRange && t > -windowStart) firstBeatRange = false;
    }
  }

  // 末尾付近の累積スコア極大から逆追跡
  const maxes: number[] = [];
  for (let t = 1; t < n - 1; t++) {
    if (cumscore[t]! > cumscore[t - 1]! && cumscore[t]! >= cumscore[t + 1]!) maxes.push(t);
  }
  if (maxes.length === 0) return [];
  const medianScore = (() => {
    const vals = maxes.map((t) => cumscore[t]!).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)]!;
  })();
  let tail = -1;
  for (let i = maxes.length - 1; i >= 0; i--) {
    if (cumscore[maxes[i]!]! >= 0.5 * medianScore) {
      tail = maxes[i]!;
      break;
    }
  }
  if (tail === -1) tail = maxes[maxes.length - 1]!;
  const beats: number[] = [];
  let cur = tail;
  while (cur >= 0) {
    beats.push(cur);
    cur = backlink[cur]!;
  }
  beats.reverse();
  return beats;
}
