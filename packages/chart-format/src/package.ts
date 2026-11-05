import { AUDIO_LIMITS, CHART_FILE_NAME } from './constants';
import { isSafeRelativeAudioFile } from './pathSafety';
import type { ChartFile, ChartIssue } from './types';
import { parseAndValidateChart, type ValidateChartOptions } from './validate';

/**
 * ファイルシステム依存を注入するためのアダプター。
 * Node 実装は `@autobeats/chart-format/node` が提供する。
 */
export interface PackageFs {
  /** 絶対パスを正規化し、シンボリックリンクを解決する。存在しなければ throw */
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  readTextFile(path: string, maxBytes: number): Promise<string>;
  /** ストリーミングで SHA-256（小文字16進）を計算する */
  sha256File(path: string): Promise<string>;
  join(...parts: string[]): string;
  /** parent 配下（parent と同じか、parent + sep で始まる）か */
  isInside(parent: string, child: string): boolean;
}

export interface VerifiedPackage {
  /** 書き出しフォルダの realpath */
  dir: string;
  chartPath: string;
  /** 実音声の realpath */
  audioPath: string;
  audioBytes: number;
  chart: ChartFile;
  warnings: ChartIssue[];
}

export type PackageVerificationResult =
  | { ok: true; pkg: VerifiedPackage }
  | { ok: false; errors: ChartIssue[]; warnings: ChartIssue[] };

/**
 * 書き出しフォルダ（chart.json + 音声）を検証する。
 * - chart.json のスキーマ・意味検証
 * - audioFile がフォルダ外（../、絶対パス、シンボリックリンク経由）を参照しないこと
 * - 実音声の存在・サイズ・SHA-256 一致
 */
export async function verifyChartPackage(
  inputDir: string,
  fs: PackageFs,
  options: ValidateChartOptions = {},
): Promise<PackageVerificationResult> {
  const warnings: ChartIssue[] = [];
  let dir: string;
  try {
    dir = await fs.realpath(inputDir);
  } catch {
    return { ok: false, errors: [{ code: 'dir-missing', message: 'フォルダが見つかりません。' }], warnings };
  }
  const dirStat = await fs.stat(dir).catch(() => null);
  if (!dirStat || !dirStat.isDirectory) {
    return { ok: false, errors: [{ code: 'not-dir', message: '選択した場所はフォルダではありません。' }], warnings };
  }

  const chartPath = fs.join(dir, CHART_FILE_NAME);
  const chartStat = await fs.stat(chartPath).catch(() => null);
  if (!chartStat || !chartStat.isFile) {
    return { ok: false, errors: [{ code: 'chart-missing', message: `フォルダ内に ${CHART_FILE_NAME} がありません。` }], warnings };
  }
  if (chartStat.size > AUDIO_LIMITS.maxChartJsonBytes) {
    return { ok: false, errors: [{ code: 'chart-too-large', message: `${CHART_FILE_NAME} が大きすぎます。` }], warnings };
  }
  let text: string;
  try {
    text = await fs.readTextFile(chartPath, AUDIO_LIMITS.maxChartJsonBytes);
  } catch {
    return { ok: false, errors: [{ code: 'chart-read', message: `${CHART_FILE_NAME} を読み取れません。` }], warnings };
  }
  const validated = parseAndValidateChart(text, options);
  if (!validated.ok) return validated;
  warnings.push(...validated.warnings);
  const chart = validated.chart;

  if (!isSafeRelativeAudioFile(chart.audioFile)) {
    return { ok: false, errors: [{ code: 'audio-file', message: 'audioFile が安全な相対ファイル名ではありません。' }], warnings };
  }
  const audioCandidate = fs.join(dir, chart.audioFile);
  let audioPath: string;
  try {
    audioPath = await fs.realpath(audioCandidate);
  } catch {
    return { ok: false, errors: [{ code: 'audio-missing', message: `音声ファイル "${chart.audioFile}" がフォルダ内にありません。` }], warnings };
  }
  if (!fs.isInside(dir, audioPath)) {
    return { ok: false, errors: [{ code: 'audio-escape', message: `音声ファイル "${chart.audioFile}" が書き出しフォルダの外を参照しています（シンボリックリンク等）。` }], warnings };
  }
  const audioStat = await fs.stat(audioPath).catch(() => null);
  if (!audioStat || !audioStat.isFile) {
    return { ok: false, errors: [{ code: 'audio-not-file', message: `"${chart.audioFile}" は通常のファイルではありません。` }], warnings };
  }
  if (audioStat.size === 0) {
    return { ok: false, errors: [{ code: 'audio-empty', message: '音声ファイルが空です。' }], warnings };
  }
  if (audioStat.size > AUDIO_LIMITS.maxFileBytes) {
    return { ok: false, errors: [{ code: 'audio-too-large', message: `音声ファイルが上限（${Math.round(AUDIO_LIMITS.maxFileBytes / 1024 / 1024)}MB）を超えています。` }], warnings };
  }
  const sha = await fs.sha256File(audioPath);
  if (sha !== chart.audioSha256) {
    return {
      ok: false,
      errors: [{ code: 'sha256-mismatch', message: '音声ファイルの SHA-256 が chart.json の audioSha256 と一致しません。音声が差し替えられたか破損しています。' }],
      warnings,
    };
  }
  return { ok: true, pkg: { dir, chartPath, audioPath, audioBytes: audioStat.size, chart, warnings } };
}
