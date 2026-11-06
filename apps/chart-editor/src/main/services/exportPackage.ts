import {
  CHART_FILE_NAME,
  CHART_FORMAT,
  DEFAULT_LEVEL_SETTINGS,
  LEVEL_PRIORITY,
  LEVEL_KEYS,
  isValidTrackId,
  serializeChart,
  validateChart,
  verifyChartPackage,
  type ChartFile,
  type ChartIssue,
  type LevelKey,
} from '@autobeats/chart-format';
import { atomicWriteFile, findAvailablePath, nodePackageFs } from '@autobeats/chart-format/node';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { findNoteIssues } from '../../renderer/src/store/document';
import type { EditorDocument } from '../../shared/types';

/** 編集ドキュメントからゲーム用 ChartFile を組み立てる（検証は validateChart で行う） */
export function documentToChart(doc: EditorDocument, audioFileName: string): ChartFile {
  const levels = {} as ChartFile['levels'];
  for (const k of LEVEL_KEYS) {
    levels[k] = {
      displayName: doc.levels[k].displayName,
      notes: [...doc.levels[k].notes]
        .sort((a, b) => a.hitAtMs - b.hitAtMs)
        .map((n) => ({ id: n.id, hitAtMs: Math.round(n.hitAtMs), source: n.source, ...(n.reason ? { reason: n.reason } : {}), ...(n.type ? { type: n.type } : {}), ...(n.type === 'mash' ? { durationMs: n.durationMs } : {}) })),
    };
  }
  return {
    format: CHART_FORMAT,
    formatVersion: 1,
    trackId: doc.trackId,
    title: doc.title,
    artist: doc.artist,
    audioFile: audioFileName,
    audioSha256: doc.audio?.sha256 ?? '',
    durationMs: doc.audio?.durationMs ?? 0,
    bpm: doc.bpm,
    offsetMs: Math.round(doc.offsetMs),
    analysis: { engineVersion: doc.analysis?.engineVersion ?? 'manual', analyzedAt: doc.analysis?.analyzedAt ?? new Date().toISOString() },
    choruses: [...doc.choruses].sort((a, b) => a.startMs - b.startMs).map((c) => ({ ...c })),
    levels,
    generationRules: { noteMode: doc.noteMode ?? 'independent', crossLevelExclusionMs: doc.noteMode === 'additive' ? 80 : 0, levelPriority: [...LEVEL_PRIORITY], crossLevelNotesAreExclusive: doc.noteMode === 'additive' },
  };
}

/** エディターの書き出し前検証オプション: 同一レベルの最小間隔違反をエラーにする */
export function exportValidationOptions(doc: EditorDocument) {
  return { minGapMsByLevel: minGapMapFromDocument(doc), minGapAsError: true };
}

export function minGapMapFromDocument(doc: EditorDocument): Record<LevelKey, number> {
  const out = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) out[k] = Math.max(doc.noteMode === 'additive' ? 81 : 1, doc.levelSettings[k]?.minGapMs ?? DEFAULT_LEVEL_SETTINGS[Number(k) as 1 | 2 | 3 | 4].minGapMs);
  return out;
}

export type ExportMode = 'ask' | 'overwrite' | 'rename';

export type ExportPackageResult =
  | { status: 'ok'; dir: string; warnings: ChartIssue[] }
  | { status: 'exists'; dir: string }
  | { status: 'error'; errors: ChartIssue[] };

/**
 * ゲーム用フォルダ `<parentDir>/<trackId>/` を書き出し、書き出し後に再検証する。
 * - 元音声はバイト列コピー（再エンコードしない）
 * - 既存フォルダは mode=ask では上書きせず exists を返す
 */
export async function exportGamePackage(doc: EditorDocument, audioPath: string, parentDir: string, mode: ExportMode): Promise<ExportPackageResult> {
  if (!doc.audio) return { status: 'error', errors: [{ code: 'no-audio', message: '楽曲が読み込まれていません。' }] };
  if (!isValidTrackId(doc.trackId)) return { status: 'error', errors: [{ code: 'track-id', message: `楽曲ID "${doc.trackId}" が不正です。英小文字・数字・-・_ のみ使えます。`, path: 'trackId' }] };
  const audioFileName = `audio${doc.audio.extension}`;
  const chart = documentToChart(doc, audioFileName);
  const validationOptions = exportValidationOptions(doc);
  const additionIssues = findNoteIssues(doc).filter((i) => i.code === 'cross-level');
  if (additionIssues.length) return { status: 'error', errors: additionIssues.map((i) => ({ code: i.code, message: i.message })) };
  const validated = validateChart(chart, validationOptions);
  if (!validated.ok) return { status: 'error', errors: validated.errors };

  let dir = path.join(parentDir, doc.trackId);
  const rel = path.relative(parentDir, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return { status: 'error', errors: [{ code: 'path', message: '書き出し先のパスが不正です。' }] };
  }
  const exists = await fsp
    .stat(dir)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    if (mode === 'ask') return { status: 'exists', dir };
    if (mode === 'rename') dir = await findAvailablePath(dir);
    if (mode === 'overwrite') {
      // フォルダ内の chart.json と音声だけを置き換える（他のファイルは触らない）
    }
  }
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(audioPath, path.join(dir, audioFileName));
    await atomicWriteFile(path.join(dir, CHART_FILE_NAME), serializeChart(validated.chart));
  } catch (err) {
    return { status: 'error', errors: [{ code: 'write', message: `書き出しに失敗しました: ${(err as Error).message}` }] };
  }
  const verified = await verifyChartPackage(dir, nodePackageFs, validationOptions);
  if (!verified.ok) return { status: 'error', errors: [{ code: 'reverify', message: '書き出し後の再検証に失敗しました。' }, ...verified.errors] };
  return { status: 'ok', dir, warnings: [...validated.warnings] };
}

/** chart.json だけを指定パスへ書き出す（音声はコピーしない） */
export async function exportChartJson(doc: EditorDocument, filePath: string): Promise<{ ok: true; warnings: ChartIssue[] } | { ok: false; errors: ChartIssue[] }> {
  if (!doc.audio) return { ok: false, errors: [{ code: 'no-audio', message: '楽曲が読み込まれていません。' }] };
  const chart = documentToChart(doc, `audio${doc.audio.extension}`);
  const additionIssues = findNoteIssues(doc).filter((i) => i.code === 'cross-level');
  if (additionIssues.length) return { ok: false, errors: additionIssues.map((i) => ({ code: i.code, message: i.message })) };
  const validated = validateChart(chart, exportValidationOptions(doc));
  if (!validated.ok) return { ok: false, errors: validated.errors };
  await atomicWriteFile(filePath, serializeChart(validated.chart));
  return { ok: true, warnings: validated.warnings };
}

export { verifyChartPackage, nodePackageFs };
