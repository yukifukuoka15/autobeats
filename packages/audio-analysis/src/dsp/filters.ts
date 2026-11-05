export function movingAverage(x: Float32Array, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + x[i]!;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    out[i] = (prefix[b]! - prefix[a]!) / (b - a);
  }
  return out;
}

export function movingMax(x: Float32Array, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    const a = Math.max(0, i - radius);
    const b = Math.min(n - 1, i + radius);
    for (let j = a; j <= b; j++) if (x[j]! > m) m = x[j]!;
    out[i] = m;
  }
  return out;
}

export function percentile(x: ArrayLike<number>, p: number): number {
  const n = x.length;
  if (n === 0) return 0;
  const arr = Array.from(x as ArrayLike<number>).sort((a, b) => a - b);
  const idx = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))));
  return arr[idx]!;
}

export function mean(x: ArrayLike<number>, start = 0, end = x.length): number {
  if (end <= start) return 0;
  let s = 0;
  for (let i = start; i < end; i++) s += x[i]!;
  return s / (end - start);
}

export function std(x: ArrayLike<number>): number {
  const n = x.length;
  if (n === 0) return 0;
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i]! - m;
    s += d * d;
  }
  return Math.sqrt(s / n);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 放物線補間でピーク位置を小数精度にする（index-1, index, index+1 を使う） */
export function parabolicPeak(y: ArrayLike<number>, index: number): { position: number; value: number } {
  if (index <= 0 || index >= y.length - 1) return { position: index, value: y[index] ?? 0 };
  const a = y[index - 1]!;
  const b = y[index]!;
  const c = y[index + 1]!;
  const denom = a - 2 * b + c;
  if (Math.abs(denom) < 1e-12) return { position: index, value: b };
  const offset = (0.5 * (a - c)) / denom;
  const value = b - 0.25 * (a - c) * offset;
  return { position: index + offset, value };
}
