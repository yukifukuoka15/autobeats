import type { CHART_FORMAT } from './constants';

export type LevelNumber = 1 | 2 | 3 | 4;
export type LevelKey = '1' | '2' | '3' | '4';

export type NoteSource = 'generated' | 'manual';

/** 生成理由タグ。将来増やしてよい（検証は文字列として受け付ける） */
export type NoteReason =
  | 'downbeat'
  | 'beat'
  | 'offbeat'
  | 'onset'
  | 'subdivision'
  | 'chorus'
  | 'manual'
  | (string & {});

/**
 * ヒットの種別。
 * - tap（既定）: 実物ボタンを 1 回押す通常のヒット
 * - mash: 連打。hitAtMs から durationMs の間ボタンを連打する（手動入力のみ。自動解析では生成しない）
 */
export type NoteType = 'tap' | 'mash' | (string & {});

export interface ChartNote {
  id: string;
  /** 楽曲時刻（整数ミリ秒）。連打では区間の開始 */
  hitAtMs: number;
  source: NoteSource;
  reason?: NoteReason;
  type?: NoteType;
  /** 連打の長さ（整数ミリ秒、type === 'mash' のとき必須） */
  durationMs?: number;
}

export type ChorusSource = 'detected' | 'manual';

export interface ChorusSection {
  id: string;
  startMs: number;
  endMs: number;
  /** 0～1 */
  confidence: number;
  source: ChorusSource;
}

export interface ChartLevel {
  displayName: string;
  notes: ChartNote[];
}

export interface ChartAnalysisMeta {
  engineVersion: string;
  /** ISO 8601 */
  analyzedAt: string;
}

export interface ChartFile {
  format: typeof CHART_FORMAT;
  formatVersion: 1;
  trackId: string;
  title: string;
  artist: string;
  /** 書き出しフォルダ内の相対ファイル名（例: audio.mp3） */
  audioFile: string;
  /** 64文字の16進 SHA-256 */
  audioSha256: string;
  durationMs: number;
  bpm: number;
  offsetMs: number;
  analysis: ChartAnalysisMeta;
  choruses: ChorusSection[];
  levels: Record<LevelKey, ChartLevel>;
  /** 任意: 生成ルール（formatVersion 1 の追加フィールド。未知として無視してよい） */
  generationRules?: ChartGenerationRules;
}

export interface ChartGenerationRules {
  crossLevelExclusionMs: number;
  levelPriority: number[];
  crossLevelNotesAreExclusive: boolean;
}

export type Judgement = 'PERFECT' | 'GOOD' | 'BAD' | 'MISS';
export type EarlyLate = 'EARLY' | 'LATE' | null;

export interface ChartIssue {
  /** 機械判定用コード */
  code: string;
  /** 日本語メッセージ */
  message: string;
  /** 例: "levels.2.notes[3]" */
  path?: string;
}
