import type { ChorusSection } from '@autobeats/chart-format';

/** 解析エンジンのバージョン。結果の互換性が変わるときに上げる。キャッシュキーにも使用する。 */
export const ANALYSIS_ENGINE_VERSION = '1.0.0';

export interface AnalysisInput {
  sampleRate: number;
  /** チャンネルごとの PCM（-1～1）。モノラルなら1本 */
  channels: Float32Array[];
}

export interface DetectedOnset {
  timeMs: number;
  /** 0～1 */
  strength: number;
}

export interface DetectedSection {
  startMs: number;
  endMs: number;
  /** 反復クラスタ番号（同じ番号は似た区間） */
  cluster: number;
  /** 区間の平均エネルギー（0～1） */
  energy: number;
  /** 反復性スコア（0～1） */
  repetition: number;
}

export interface AnalysisResult {
  engineVersion: string;
  analyzedAt: string;
  durationMs: number;
  sampleRate: number;
  /** 推定 BPM（小数あり） */
  bpm: number;
  /** BPM 推定の信頼度 0～1 */
  bpmConfidence: number;
  /** 最初の拍の位置（ms）。chart.offsetMs に流用する */
  offsetMs: number;
  beatsPerBar: number;
  /** 拍位置（整数 ms、昇順） */
  beats: number[];
  /** 小節頭（beats の部分集合） */
  downbeats: number[];
  onsets: DetectedOnset[];
  sections: DetectedSection[];
  choruses: ChorusSection[];
  /** 先頭の無音が終わる時刻 */
  leadInEndMs: number;
  /** 末尾の無音が始まる時刻 */
  tailStartMs: number;
  /** 解析フレーム間隔（ms） */
  frameHopMs: number;
  /** フレームごとの正規化エネルギー（0～1、UI 表示用。長時間音源では間引き済み） */
  energyCurve: number[];
  /** energyCurve の1要素あたりの時間（ms） */
  energyCurveStepMs: number;
}

export type AnalysisStage =
  | 'prepare'
  | 'features'
  | 'onsets'
  | 'tempo'
  | 'beats'
  | 'structure'
  | 'chorus'
  | 'finish';

export interface AnalysisProgress {
  stage: AnalysisStage;
  /** 0～1 全体進捗 */
  ratio: number;
  message: string;
}

export interface AnalysisControl {
  onProgress?: (p: AnalysisProgress) => void;
  /** true を返すと解析を中断し AnalysisCancelledError を投げる */
  isCancelled?: () => boolean;
  /** 長い処理の途中でイベントループへ譲る（Worker でのキャンセル受信用） */
  yieldToEventLoop?: () => Promise<void>;
}

export class AnalysisCancelledError extends Error {
  constructor() {
    super('解析がキャンセルされました');
    this.name = 'AnalysisCancelledError';
  }
}

export class AudioInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AudioInputError';
  }
}
