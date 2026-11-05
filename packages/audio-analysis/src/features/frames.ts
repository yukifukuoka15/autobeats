import { FFT, hannWindow } from '../dsp/fft';
import type { AnalysisControl } from '../types';
import { AnalysisCancelledError } from '../types';

export const ANALYSIS_SAMPLE_RATE = 22050;
export const FRAME_SIZE = 1024;
export const HOP_SIZE = 256;
export const NUM_BANDS = 40;
export const CHROMA_BINS = 12;
/** chroma は周波数分解能を上げるため大きな窓で、オンセットフレーム CHROMA_STRIDE 個ごとに計算する */
export const CHROMA_FFT_SIZE = 4096;
export const CHROMA_STRIDE = 4;

export interface FrameFeatures {
  sampleRate: number;
  hopSize: number;
  frameCount: number;
  /** 1フレームの時間（ms） */
  hopMs: number;
  /** スペクトルフラックス（オンセット包絡の素） */
  flux: Float32Array;
  /** フレーム RMS */
  rms: Float32Array;
  /** 低域（<150Hz）エネルギー */
  low: Float32Array;
  /** スペクトル重心（0～1 正規化） */
  centroid: Float32Array;
  /** 12 × chromaFrameCount（L2 正規化済み）。オンセットフレーム t の chroma は chromaAt(t) で取る */
  chroma: Float32Array;
  chromaFrameCount: number;
  /** オンセットフレーム何個につき chroma 1フレームか */
  chromaStride: number;
}

/** オンセットフレーム番号に対応する chroma ベクトル（12 要素のビュー） */
export function chromaAt(features: FrameFeatures, frame: number): Float32Array {
  const c = Math.max(0, Math.min(features.chromaFrameCount - 1, Math.floor(frame / features.chromaStride)));
  return features.chroma.subarray(c * CHROMA_BINS, c * CHROMA_BINS + CHROMA_BINS);
}

interface BandFilter {
  start: number;
  end: number;
  weights: Float32Array;
}

function buildBandFilters(sampleRate: number, fftSize: number): BandFilter[] {
  const bins = fftSize / 2 + 1;
  const binHz = sampleRate / fftSize;
  const fMin = 40;
  const fMax = Math.min(10000, sampleRate / 2);
  const edges: number[] = [];
  const logMin = Math.log(fMin);
  const logMax = Math.log(fMax);
  for (let i = 0; i <= NUM_BANDS + 1; i++) edges.push(Math.exp(logMin + ((logMax - logMin) * i) / (NUM_BANDS + 1)));
  const filters: BandFilter[] = [];
  for (let b = 0; b < NUM_BANDS; b++) {
    const lo = edges[b]!;
    const mid = edges[b + 1]!;
    const hi = edges[b + 2]!;
    const start = Math.max(0, Math.floor(lo / binHz));
    const end = Math.min(bins - 1, Math.ceil(hi / binHz));
    const weights = new Float32Array(end - start + 1);
    for (let k = start; k <= end; k++) {
      const f = k * binHz;
      let w = 0;
      if (f >= lo && f <= mid) w = (f - lo) / Math.max(1e-9, mid - lo);
      else if (f > mid && f <= hi) w = (hi - f) / Math.max(1e-9, hi - mid);
      weights[k - start] = w;
    }
    filters.push({ start, end, weights });
  }
  return filters;
}

function buildChromaMap(sampleRate: number, fftSize: number): Int16Array {
  const bins = fftSize / 2 + 1;
  const binHz = sampleRate / fftSize;
  const map = new Int16Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    if (f < 55 || f > 4200) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    map[k] = pc;
  }
  return map;
}

/**
 * 解析用モノラル PCM からフレーム特徴量を抽出する。
 * フルスペクトログラムは保持せず、フレームごとの派生特徴だけを残す（30分音源でもメモリを抑える）。
 */
export async function extractFrameFeatures(
  mono: Float32Array,
  sampleRate: number,
  control: AnalysisControl = {},
  progress?: (ratio: number) => void,
): Promise<FrameFeatures> {
  const fft = new FFT(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const bins = FRAME_SIZE / 2 + 1;
  const binHz = sampleRate / FRAME_SIZE;
  const filters = buildBandFilters(sampleRate, FRAME_SIZE);
  const lowBinMax = Math.floor(150 / binHz);

  // 中心基準のフレーム: フレーム t の中心がサンプル t*HOP_SIZE になるよう前後へ半窓分の無音を足す
  const half = FRAME_SIZE / 2;
  const padded = new Float32Array(mono.length + FRAME_SIZE);
  padded.set(mono, half);
  const frameCount = Math.max(0, Math.floor(mono.length / HOP_SIZE) + 1);
  const flux = new Float32Array(frameCount);
  const rms = new Float32Array(frameCount);
  const low = new Float32Array(frameCount);
  const centroid = new Float32Array(frameCount);

  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);
  const frame = new Float32Array(FRAME_SIZE);
  const mag = new Float32Array(bins);
  let prevBands = new Float32Array(NUM_BANDS);
  const curBands = new Float32Array(NUM_BANDS);
  const yieldEvery = 800;

  for (let t = 0; t < frameCount; t++) {
    const offset = t * HOP_SIZE;
    let energy = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const s = padded[offset + i]!;
      energy += s * s;
      frame[i] = s * window[i]!;
    }
    rms[t] = Math.sqrt(energy / FRAME_SIZE);
    fft.magnitude(frame, mag, re, im);

    // 帯域エネルギー（対数圧縮）
    for (let b = 0; b < NUM_BANDS; b++) {
      const f = filters[b]!;
      let e = 0;
      for (let k = f.start; k <= f.end; k++) e += mag[k]! * f.weights[k - f.start]!;
      curBands[b] = Math.log1p(10 * e);
    }
    // superflux 風: 前フレームの隣接帯域最大との差を半波整流
    let fl = 0;
    for (let b = 0; b < NUM_BANDS; b++) {
      const pm = Math.max(prevBands[b]!, prevBands[b - 1] ?? 0, prevBands[b + 1] ?? 0);
      const d = curBands[b]! - pm;
      if (d > 0) fl += d;
    }
    flux[t] = t === 0 ? 0 : fl;
    const tmp = prevBands;
    prevBands = curBands.slice();
    void tmp;

    // 低域・重心
    let lowE = 0;
    let wsum = 0;
    let msum = 0;
    for (let k = 1; k < bins; k++) {
      const m = mag[k]!;
      if (k <= lowBinMax) lowE += m * m;
      wsum += k * m;
      msum += m;
    }
    low[t] = Math.sqrt(lowE / Math.max(1, lowBinMax));
    centroid[t] = msum > 1e-9 ? wsum / msum / bins : 0;

    if (t % yieldEvery === 0) {
      if (control.isCancelled?.()) throw new AnalysisCancelledError();
      progress?.((0.7 * t) / Math.max(1, frameCount));
      if (control.yieldToEventLoop) await control.yieldToEventLoop();
    }
  }

  // chroma パス（大きな窓・粗いホップ）
  const chromaFrameCount = Math.max(1, Math.ceil(frameCount / CHROMA_STRIDE));
  const chroma = new Float32Array(chromaFrameCount * CHROMA_BINS);
  {
    const cfft = new FFT(CHROMA_FFT_SIZE);
    const cwin = hannWindow(CHROMA_FFT_SIZE);
    const cbins = CHROMA_FFT_SIZE / 2 + 1;
    const chromaMap = buildChromaMap(sampleRate, CHROMA_FFT_SIZE);
    const cre = new Float64Array(CHROMA_FFT_SIZE);
    const cim = new Float64Array(CHROMA_FFT_SIZE);
    const cframe = new Float32Array(CHROMA_FFT_SIZE);
    const cmag = new Float32Array(cbins);
    const chromaFrame = new Float64Array(CHROMA_BINS);
    const chalf = CHROMA_FFT_SIZE / 2;
    for (let c = 0; c < chromaFrameCount; c++) {
      const center = c * CHROMA_STRIDE * HOP_SIZE;
      for (let i = 0; i < CHROMA_FFT_SIZE; i++) {
        const idx = center - chalf + i;
        cframe[i] = (idx >= 0 && idx < mono.length ? mono[idx]! : 0) * cwin[i]!;
      }
      cfft.magnitude(cframe, cmag, cre, cim);
      chromaFrame.fill(0);
      for (let k = 1; k < cbins; k++) {
        const pc = chromaMap[k]!;
        if (pc >= 0) chromaFrame[pc] = chromaFrame[pc]! + cmag[k]! * cmag[k]!;
      }
      let norm = 0;
      for (let b = 0; b < CHROMA_BINS; b++) norm += chromaFrame[b]! * chromaFrame[b]!;
      norm = Math.sqrt(norm);
      for (let b = 0; b < CHROMA_BINS; b++) chroma[c * CHROMA_BINS + b] = norm > 1e-9 ? chromaFrame[b]! / norm : 0;
      if (c % 200 === 0) {
        if (control.isCancelled?.()) throw new AnalysisCancelledError();
        progress?.(0.7 + (0.3 * c) / chromaFrameCount);
        if (control.yieldToEventLoop) await control.yieldToEventLoop();
      }
    }
  }
  return {
    sampleRate,
    hopSize: HOP_SIZE,
    frameCount,
    hopMs: (HOP_SIZE / sampleRate) * 1000,
    flux,
    rms,
    low,
    centroid,
    chroma,
    chromaFrameCount,
    chromaStride: CHROMA_STRIDE,
  };
}
