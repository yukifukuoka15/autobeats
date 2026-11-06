/** 一定テンポが十分支持される曲だけ、拍の局所的な揺れを共通グリッドへ整える。 */
export function stabilizeBeatGrid(timesMs: readonly number[], weights: readonly number[], bpm: number): { timesMs: number[]; bpm: number; confidence: number } | null {
  if (timesMs.length < 32 || timesMs.length !== weights.length || !(bpm > 0)) return null;
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total < 1e-6) return null;
  const initialPeriod = 60000 / bpm;
  const evaluate = (period: number) => {
    let re = 0, im = 0;
    for (let i = 0; i < timesMs.length; i++) {
      const angle = 2 * Math.PI * timesMs[i]! / period;
      re += Math.cos(angle) * Math.max(0, weights[i]!);
      im += Math.sin(angle) * Math.max(0, weights[i]!);
    }
    return { score: Math.hypot(re, im) / total, phase: Math.atan2(im, re) * period / (2 * Math.PI) };
  };
  let period = initialPeriod, best = evaluate(period);
  for (let i = -120; i <= 120; i++) {
    const candidate = initialPeriod * (1 + i * 0.00025);
    const score = evaluate(candidate);
    if (score.score > best.score) { period = candidate; best = score; }
  }
  // 曲の一部だけが一定でも全体を固定しない。各区間の位相も確認する。
  if (best.score < 0.88) return null;
  const first = timesMs[0]!, last = timesMs[timesMs.length - 1]!;
  if (last - first < 12000) return null;
  for (let section = 0; section < 4; section++) {
    let re = 0, im = 0, sum = 0;
    for (let i = 0; i < timesMs.length; i++) {
      const fraction = (timesMs[i]! - first) / (last - first);
      if (Math.min(3, Math.floor(fraction * 4)) !== section) continue;
      const w = Math.max(0, weights[i]!);
      const angle = 2 * Math.PI * (timesMs[i]! - best.phase) / period;
      re += Math.cos(angle) * w; im += Math.sin(angle) * w; sum += w;
    }
    if (sum > total * 0.025 && (Math.hypot(re, im) / sum < 0.72 || Math.abs(Math.atan2(im, re)) > 0.4)) return null;
  }
  const times: number[] = [];
  for (let k = Math.ceil((first - period * 0.2 - best.phase) / period); ; k++) {
    const t = best.phase + k * period;
    if (t > last + period * 0.2) break;
    if (t >= 0) times.push(t);
  }
  return { timesMs: times, bpm: 60000 / period, confidence: best.score };
}
