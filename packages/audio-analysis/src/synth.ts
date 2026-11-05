/**
 * テスト・フィクスチャ用の合成音。著作物を含まない。
 */

export function silence(durationSec: number, sampleRate = 44100): Float32Array {
  return new Float32Array(Math.round(durationSec * sampleRate));
}

export function sine(freq: number, durationSec: number, sampleRate = 44100, amplitude = 0.5): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** 決定的な疑似乱数（テストの再現性のため） */
export function makeRng(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

function addBurst(buf: Float32Array, startSample: number, durationSec: number, sampleRate: number, gen: (i: number, t: number) => number, amp: number) {
  const n = Math.round(durationSec * sampleRate);
  for (let i = 0; i < n && startSample + i < buf.length; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / (durationSec / 4));
    buf[startSample + i] = buf[startSample + i]! + amp * env * gen(i, t);
  }
}

export interface ClickTrackOptions {
  bpm: number;
  durationSec: number;
  sampleRate?: number;
  /** 何拍ごとにアクセントを付けるか（0 でアクセントなし） */
  accentEvery?: number;
  /** 最初のクリックまでのオフセット（秒） */
  startOffsetSec?: number;
}

/** 既知 BPM のクリック音 */
export function synthesizeClickTrack(options: ClickTrackOptions): Float32Array {
  const sampleRate = options.sampleRate ?? 44100;
  const buf = new Float32Array(Math.round(options.durationSec * sampleRate));
  const period = 60 / options.bpm;
  const accentEvery = options.accentEvery ?? 4;
  const rng = makeRng(7);
  let beat = 0;
  for (let t = options.startOffsetSec ?? 0; t < options.durationSec; t += period, beat++) {
    const accent = accentEvery > 0 && beat % accentEvery === 0;
    const start = Math.round(t * sampleRate);
    const freq = accent ? 1500 : 1000;
    addBurst(buf, start, 0.03, sampleRate, (_, tt) => Math.sin(2 * Math.PI * freq * tt) + 0.3 * (rng() * 2 - 1), accent ? 0.9 : 0.6);
  }
  return buf;
}

export interface SongLikeSection {
  bars: number;
  kind: 'verse' | 'chorus' | 'bridge' | 'intro';
}

export interface SongLikeOptions {
  bpm: number;
  sampleRate?: number;
  sections: SongLikeSection[];
  /** 曲頭の無音（秒） */
  leadInSec?: number;
  /** 曲末の無音（秒） */
  tailSec?: number;
}

const CHORDS: Record<SongLikeSection['kind'], number[][]> = {
  intro: [[220, 261.63, 329.63]],
  verse: [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [196, 246.94, 293.66],
    [164.81, 196, 246.94],
  ],
  chorus: [
    [261.63, 329.63, 392],
    [293.66, 349.23, 440],
    [329.63, 392, 493.88],
    [349.23, 440, 523.25],
  ],
  bridge: [
    [146.83, 174.61, 220],
    [130.81, 164.81, 196],
  ],
};

/**
 * 構造を持った合成曲。verse は静かで疎、chorus は大きく密で異なる和音進行。
 * サビ推定・構成推定・難易度生成テスト用。
 */
export function synthesizeSongLike(options: SongLikeOptions): { pcm: Float32Array; sectionsMs: { kind: SongLikeSection['kind']; startMs: number; endMs: number }[]; durationMs: number } {
  const sampleRate = options.sampleRate ?? 44100;
  const beatSec = 60 / options.bpm;
  const barSec = beatSec * 4;
  const leadIn = options.leadInSec ?? 0;
  const tail = options.tailSec ?? 0;
  const totalBars = options.sections.reduce((s, x) => s + x.bars, 0);
  const durationSec = leadIn + totalBars * barSec + tail;
  const buf = new Float32Array(Math.round(durationSec * sampleRate));
  const rng = makeRng(42);
  const sectionsMs: { kind: SongLikeSection['kind']; startMs: number; endMs: number }[] = [];
  let bar = 0;
  for (const sec of options.sections) {
    const secStart = leadIn + bar * barSec;
    sectionsMs.push({ kind: sec.kind, startMs: Math.round(secStart * 1000), endMs: Math.round((secStart + sec.bars * barSec) * 1000) });
    const chords = CHORDS[sec.kind];
    const loud = sec.kind === 'chorus' ? 1 : sec.kind === 'bridge' ? 0.6 : 0.5;
    for (let b = 0; b < sec.bars; b++, bar++) {
      const barStart = leadIn + bar * barSec;
      const chord = chords[b % chords.length]!;
      // パッド（和音）
      const padStart = Math.round(barStart * sampleRate);
      const padLen = Math.round(barSec * sampleRate);
      for (let i = 0; i < padLen && padStart + i < buf.length; i++) {
        const t = i / sampleRate;
        let v = 0;
        for (const f of chord) v += Math.sin(2 * Math.PI * f * t);
        const env = Math.min(1, t / 0.02) * Math.min(1, (barSec - t) / 0.05);
        buf[padStart + i] = buf[padStart + i]! + 0.08 * loud * env * v;
      }
      for (let beat = 0; beat < 4; beat++) {
        const bt = barStart + beat * beatSec;
        const s = Math.round(bt * sampleRate);
        // キック（1,3拍）
        if (beat === 0 || beat === 2) {
          addBurst(buf, s, 0.15, sampleRate, (_, t) => Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) * t), 0.9 * loud);
        }
        // スネア（2,4拍）
        if (beat === 1 || beat === 3) {
          addBurst(buf, s, 0.12, sampleRate, () => rng() * 2 - 1, 0.5 * loud);
        }
        // ハイハット（verse は8分、chorus は16分）
        const hatDiv = sec.kind === 'chorus' ? 4 : 2;
        for (let h = 0; h < hatDiv; h++) {
          const hs = Math.round((bt + (beatSec * h) / hatDiv) * sampleRate);
          addBurst(buf, hs, 0.03, sampleRate, () => (rng() * 2 - 1) * 0.7, 0.25 * loud);
        }
        // サビはリードメロディを追加
        if (sec.kind === 'chorus') {
          const lead = chord[(beat + b) % chord.length]! * 2;
          addBurst(buf, s, beatSec * 0.9, sampleRate, (_, t) => Math.sin(2 * Math.PI * lead * t), 0.35);
        }
      }
    }
  }
  // クリッピング防止
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]!));
  if (peak > 0.95) for (let i = 0; i < buf.length; i++) buf[i] = (buf[i]! / peak) * 0.95;
  return { pcm: buf, sectionsMs, durationMs: Math.round(durationSec * 1000) };
}
