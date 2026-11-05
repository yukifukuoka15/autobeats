import { AUDIO_LIMITS, normalizeChoruses } from '@autobeats/chart-format';
import { median } from './dsp/filters';
import { mixToMono, resampleLinear } from './dsp/resample';
import { trackBeats } from './features/beats';
import { estimateDownbeats } from './features/downbeat';
import { ANALYSIS_SAMPLE_RATE, FRAME_SIZE, extractFrameFeatures } from './features/frames';
import { parabolicPeak } from './dsp/filters';

/**
 * スペクトルフラックスは音が窓へ入り始めた時点で立ち上がるため、実際の発音より少し早く検出される。
 * 合成クリックでの実測に基づく補正値（ms）。
 */
export const ONSET_LATENCY_COMPENSATION_MS = 12;

function refineBeatFrame(envelope: Float32Array, frame: number): number {
  // 拍フレーム近傍（±2）で最大の包絡位置を探し放物線補間する
  let best = frame;
  for (let k = Math.max(0, frame - 2); k <= Math.min(envelope.length - 1, frame + 2); k++) {
    if (envelope[k]! > envelope[best]!) best = k;
  }
  if (envelope[best]! <= 0) return frame;
  const p = parabolicPeak(envelope, best);
  return Math.abs(p.position - best) <= 1 ? p.position : best;
}

/** 拍時刻列の線形回帰から BPM を求める（一定テンポ前提） */
function regressionBpm(timesMs: number[]): number | null {
  const n = timesMs.length;
  if (n < 8) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += timesMs[i]!;
    sxx += i * i;
    sxy += i * timesMs[i]!;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return slope > 0 ? 60000 / slope : null;
}
import { buildOnsetEnvelope, pickOnsets } from './features/onset';
import { analyzeStructure, buildBeatSyncFeatures } from './features/structure';
import { estimateTempo } from './features/tempo';
import {
  ANALYSIS_ENGINE_VERSION,
  AnalysisCancelledError,
  AudioInputError,
  type AnalysisControl,
  type AnalysisInput,
  type AnalysisResult,
  type AnalysisStage,
} from './types';

/** 入力 PCM の妥当性を検証する。問題があれば AudioInputError を投げる */
export function validateAnalysisInput(input: AnalysisInput): { durationMs: number } {
  if (!Number.isFinite(input.sampleRate) || input.sampleRate < 8000 || input.sampleRate > 192000) {
    throw new AudioInputError('sample-rate', `サンプルレート ${input.sampleRate} Hz は対応していません。`);
  }
  if (!Array.isArray(input.channels) || input.channels.length === 0 || input.channels.length > 8) {
    throw new AudioInputError('channels', 'チャンネル構成が不正です。');
  }
  const samples = input.channels[0]!.length;
  if (!input.channels.every((c) => c instanceof Float32Array && c.length === samples)) {
    throw new AudioInputError('channels', 'チャンネルの長さが一致しません。');
  }
  const durationMs = Math.round((samples / input.sampleRate) * 1000);
  if (durationMs < AUDIO_LIMITS.minDurationMs) {
    throw new AudioInputError('too-short', `音声が短すぎます（${durationMs}ms）。${AUDIO_LIMITS.minDurationMs}ms 以上の音声を読み込んでください。`);
  }
  if (durationMs > AUDIO_LIMITS.maxDurationMs) {
    throw new AudioInputError('too-long', `音声が長すぎます（${Math.round(durationMs / 60000)}分）。上限は ${AUDIO_LIMITS.maxDurationMs / 60000} 分です。`);
  }
  let finiteCheck = 0;
  const ch = input.channels[0]!;
  for (let i = 0; i < ch.length; i += Math.max(1, Math.floor(ch.length / 1000))) {
    if (!Number.isFinite(ch[i]!)) finiteCheck++;
  }
  if (finiteCheck > 0) throw new AudioInputError('corrupt', '音声データに不正な値が含まれています。');
  return { durationMs };
}

const STAGE_WEIGHTS: Record<AnalysisStage, [number, number]> = {
  prepare: [0, 0.05],
  features: [0.05, 0.55],
  onsets: [0.55, 0.6],
  tempo: [0.6, 0.7],
  beats: [0.7, 0.8],
  structure: [0.8, 0.93],
  chorus: [0.93, 0.98],
  finish: [0.98, 1],
};

const STAGE_MESSAGES: Record<AnalysisStage, string> = {
  prepare: 'モノラル化とリサンプリング',
  features: 'スペクトル特徴量の抽出',
  onsets: 'オンセット検出',
  tempo: 'テンポ推定',
  beats: '拍と小節頭の推定',
  structure: '曲構成の推定',
  chorus: 'サビ候補の推定',
  finish: '結果の整形',
};

/**
 * 完全オフラインの楽曲解析パイプライン。
 * UI や Electron に依存せず、Worker からも Node テストからも呼べる。
 */
export async function analyzeAudio(input: AnalysisInput, control: AnalysisControl = {}): Promise<AnalysisResult> {
  const report = (stage: AnalysisStage, local = 0) => {
    const [a, b] = STAGE_WEIGHTS[stage];
    control.onProgress?.({ stage, ratio: a + (b - a) * Math.min(1, Math.max(0, local)), message: STAGE_MESSAGES[stage] });
  };
  const check = async () => {
    if (control.isCancelled?.()) throw new AnalysisCancelledError();
    if (control.yieldToEventLoop) await control.yieldToEventLoop();
  };

  const { durationMs } = validateAnalysisInput(input);
  report('prepare');
  const mono = resampleLinear(mixToMono(input.channels), input.sampleRate, ANALYSIS_SAMPLE_RATE);
  const sr = ANALYSIS_SAMPLE_RATE;
  await check();

  report('features');
  const features = await extractFrameFeatures(mono, sr, control, (r) => report('features', r));
  await check();

  report('onsets');
  const env = buildOnsetEnvelope(features.flux, features.hopMs);
  const onsets = pickOnsets(env);
  await check();

  // 無音区間
  let rmsMax = 1e-9;
  for (let t = 0; t < features.frameCount; t++) if (features.rms[t]! > rmsMax) rmsMax = features.rms[t]!;
  const silenceThreshold = Math.max(1e-4, rmsMax * 0.02);
  let leadIn = 0;
  while (leadIn < features.frameCount && features.rms[leadIn]! < silenceThreshold) leadIn++;
  let tail = features.frameCount;
  while (tail > leadIn && features.rms[tail - 1]! < silenceThreshold) tail--;
  const isSilent = leadIn >= features.frameCount;
  const leadInEndMs = isSilent ? durationMs : Math.round(leadIn * features.hopMs);
  const tailStartMs = isSilent ? durationMs : Math.min(durationMs, Math.round(((tail * features.hopSize + FRAME_SIZE / 2) / sr) * 1000));

  report('tempo');
  const tempo = estimateTempo(env.envelope, features.hopMs);
  await check();

  report('beats');
  let beatFrames = isSilent ? [] : trackBeats(env.envelope, tempo.periodFrames);
  // 無音区間の拍を除外
  beatFrames = beatFrames.filter((f) => f >= leadIn - 1 && f <= tail);
  // 拍位置をオンセット包絡の放物線補間で小数フレーム精度にする
  const refinedFrames = beatFrames.map((f) => refineBeatFrame(env.envelope, f));
  let bpm = tempo.bpm;
  if (refinedFrames.length >= 4) {
    const ibis: number[] = [];
    for (let i = 1; i < refinedFrames.length; i++) ibis.push((refinedFrames[i]! - refinedFrames[i - 1]!) * features.hopMs);
    const medIbi = median(ibis);
    if (medIbi > 0) {
      const medBpm = 60000 / medIbi;
      // 一定テンポとみなせる場合は回帰でさらに精密化
      const reg = regressionBpm(refinedFrames.map((f) => f * features.hopMs));
      bpm = reg !== null && Math.abs(reg - medBpm) / medBpm < 0.03 ? reg : medBpm;
    }
  }
  const beats = refinedFrames.map((f) => Math.max(0, Math.round(f * features.hopMs + ONSET_LATENCY_COMPENSATION_MS)));
  const down = estimateDownbeats(beatFrames, features, env.envelope);
  const downbeats = down.downbeatIndices.map((i) => beats[i]!);
  await check();

  report('structure');
  const bs = buildBeatSyncFeatures(beatFrames, features, env.envelope);
  const downbeatUnits = new Set<number>();
  for (const i of down.downbeatIndices) downbeatUnits.add(Math.floor(i / bs.beatsPerUnit));
  await check();
  report('chorus');
  const structure = isSilent ? { sections: [], choruses: [] } : analyzeStructure(bs, downbeatUnits, { durationMs, hopMs: features.hopMs });
  await check();

  report('finish');
  // UI 用エネルギー曲線（最大 4000 点に間引く）
  const step = Math.max(1, Math.ceil(features.frameCount / 4000));
  const energyCurve: number[] = [];
  for (let t = 0; t < features.frameCount; t += step) {
    let m = 0;
    for (let k = t; k < Math.min(features.frameCount, t + step); k++) if (features.rms[k]! > m) m = features.rms[k]!;
    energyCurve.push(Math.round((m / rmsMax) * 1000) / 1000);
  }

  const result: AnalysisResult = {
    engineVersion: ANALYSIS_ENGINE_VERSION,
    analyzedAt: new Date().toISOString(),
    durationMs,
    sampleRate: input.sampleRate,
    bpm: Math.round(bpm * 100) / 100,
    bpmConfidence: isSilent ? 0 : tempo.confidence,
    offsetMs: beats[0] ?? 0,
    beatsPerBar: down.beatsPerBar,
    beats,
    downbeats,
    onsets: onsets
      .map((o) => ({ timeMs: Math.max(0, o.timeMs + ONSET_LATENCY_COMPENSATION_MS), strength: o.strength }))
      .filter((o) => o.timeMs >= leadInEndMs - 20 && o.timeMs <= tailStartMs),
    sections: structure.sections,
    choruses: normalizeChoruses(structure.choruses, durationMs),
    leadInEndMs,
    tailStartMs,
    frameHopMs: features.hopMs,
    energyCurve,
    energyCurveStepMs: step * features.hopMs,
  };
  report('finish', 1);
  return result;
}
