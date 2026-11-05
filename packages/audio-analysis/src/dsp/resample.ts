/** 複数チャンネルをモノラルへ平均する */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const n = channels[0]!.length;
  const out = new Float32Array(n);
  const inv = 1 / channels.length;
  for (const ch of channels) {
    const len = Math.min(n, ch.length);
    for (let i = 0; i < len; i++) out[i] = out[i]! + ch[i]! * inv;
  }
  return out;
}

/**
 * 解析用にダウンサンプリングする。
 * 整数比のときは箱型平均（簡易ローパス）、それ以外は箱型平均の後に線形補間する。
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate < toRate) {
    const ratio = fromRate / toRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(input.length - 1, i0 + 1);
      const f = pos - i0;
      out[i] = (input[i0] ?? 0) * (1 - f) + (input[i1] ?? 0) * f;
    }
    return out;
  }
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  const box = Math.max(1, Math.round(ratio));
  for (let i = 0; i < outLen; i++) {
    const center = i * ratio;
    const start = Math.max(0, Math.floor(center - box / 2));
    const end = Math.min(input.length, start + box);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}
