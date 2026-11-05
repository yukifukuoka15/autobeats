/** 波形ピークのピラミッド（ズーム段階ごとの min/max） */
export interface PeakLevel {
  samplesPerBin: number;
  min: Float32Array;
  max: Float32Array;
}

export interface WaveformPeaks {
  sampleRate: number;
  totalSamples: number;
  levels: PeakLevel[];
}

export const PEAK_LEVELS = [64, 256, 1024, 4096, 16384] as const;

/** 複数チャンネルを統合（min は各 ch の最小、max は各 ch の最大）したピークを作る */
export function buildWaveformPeaks(channels: Float32Array[], sampleRate: number): WaveformPeaks {
  const total = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const levels: PeakLevel[] = [];
  let prev: PeakLevel | null = null;
  for (const spb of PEAK_LEVELS) {
    const bins = Math.ceil(total / spb);
    const min = new Float32Array(bins);
    const max = new Float32Array(bins);
    if (prev === null) {
      for (let b = 0; b < bins; b++) {
        let lo = Infinity;
        let hi = -Infinity;
        const start = b * spb;
        const end = Math.min(total, start + spb);
        for (const ch of channels) {
          for (let i = start; i < end && i < ch.length; i++) {
            const v = ch[i]!;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        min[b] = lo === Infinity ? 0 : lo;
        max[b] = hi === -Infinity ? 0 : hi;
      }
    } else {
      const factor = spb / prev.samplesPerBin;
      for (let b = 0; b < bins; b++) {
        let lo = Infinity;
        let hi = -Infinity;
        const start = b * factor;
        const end = Math.min(prev.min.length, start + factor);
        for (let i = start; i < end; i++) {
          if (prev.min[i]! < lo) lo = prev.min[i]!;
          if (prev.max[i]! > hi) hi = prev.max[i]!;
        }
        min[b] = lo === Infinity ? 0 : lo;
        max[b] = hi === -Infinity ? 0 : hi;
      }
    }
    const level = { samplesPerBin: spb, min, max };
    levels.push(level);
    prev = level;
  }
  return { sampleRate, totalSamples: total, levels };
}

/** 1ピクセルあたりのサンプル数に最も合うレベルを選ぶ */
export function pickPeakLevel(peaks: WaveformPeaks, samplesPerPixel: number): PeakLevel {
  let best = peaks.levels[0]!;
  for (const level of peaks.levels) {
    if (level.samplesPerBin <= samplesPerPixel) best = level;
  }
  return best;
}
