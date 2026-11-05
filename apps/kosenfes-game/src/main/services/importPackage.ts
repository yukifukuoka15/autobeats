import {
  CHART_FILE_NAME,
  isValidTrackId,
  serializeChart,
  verifyChartPackage,
  type ChartFile,
  type ChartIssue,
} from '@autobeats/chart-format';
import { atomicWriteFile, nodePackageFs, sha256File } from '@autobeats/chart-format/node';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ImportResult, LibraryEntrySummary } from '../../shared/types';
import { type LibraryStore, entryFromChart, libraryDirName, toSummary, type LibraryEntry } from './library';

export interface PendingConflict {
  pendingId: string;
  sourceDir: string;
  chart: ChartFile;
  audioPath: string;
  existing: LibraryEntry;
  createdAt: number;
}

export type ConflictResolution = 'replace' | 'new-id';

const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * ゲーム用フォルダ（chart.json + 音声）を検証してライブラリへ取り込む。
 */
export class ImportService {
  private readonly pending = new Map<string, PendingConflict>();

  constructor(private readonly library: LibraryStore) {}

  /** フォルダまたは chart.json のパスを受け取り、インポートを試みる */
  async importFrom(selectedPath: string): Promise<ImportResult> {
    let dir = selectedPath;
    try {
      const st = await fsp.stat(selectedPath);
      if (st.isFile()) {
        if (path.basename(selectedPath) !== CHART_FILE_NAME) {
          return { status: 'rejected', errors: [`${CHART_FILE_NAME} またはそれを含むフォルダを選択してください。`] };
        }
        dir = path.dirname(selectedPath);
      }
    } catch {
      return { status: 'rejected', errors: ['選択したパスにアクセスできません。'] };
    }
    const verified = await verifyChartPackage(dir, nodePackageFs);
    if (!verified.ok) return { status: 'rejected', errors: verified.errors.map(issueText) };
    const { chart, audioPath } = verified.pkg;
    const sameId = (await this.library.list()).filter((e) => e.trackId === chart.trackId);
    const exact = sameId.find((e) => e.audioSha256 === chart.audioSha256);
    if (exact) {
      // 同じ trackId と同じハッシュは重複登録しない（内容が同じかも確認）
      return { status: 'duplicate', entry: toSummary(exact) };
    }
    if (sameId.length > 0) {
      const pendingId = randomUUID();
      this.prunePending();
      this.pending.set(pendingId, { pendingId, sourceDir: verified.pkg.dir, chart, audioPath, existing: sameId[0]!, createdAt: Date.now() });
      return {
        status: 'conflict',
        pendingId,
        existing: toSummary(sameId[0]!),
        incoming: { trackId: chart.trackId, title: chart.title, audioSha256: chart.audioSha256 },
      };
    }
    return this.copyIntoLibrary(chart, audioPath, verified.pkg.warnings);
  }

  /** 同一 trackId・異なる内容の衝突を解決する */
  async resolveConflict(pendingId: string, resolution: ConflictResolution, isTrackInUse: (trackId: string, sha: string) => boolean): Promise<ImportResult> {
    const p = this.pending.get(pendingId);
    if (!p) return { status: 'rejected', errors: ['保留中のインポートが見つかりません。もう一度インポートしてください。'] };
    this.pending.delete(pendingId);
    if (resolution === 'replace') {
      if (isTrackInUse(p.existing.trackId, p.existing.audioSha256)) {
        return { status: 'rejected', errors: ['プレイ中の楽曲は置換できません。'] };
      }
      const result = await this.copyIntoLibrary(p.chart, p.audioPath, []);
      if (result.status === 'imported') {
        // 新しい登録が成功してから古いものを削除する
        await this.library.remove(p.existing.trackId, p.existing.audioSha256);
      }
      return result;
    }
    const newId = await this.allocateNewId(p.chart.trackId);
    const chart: ChartFile = { ...p.chart, trackId: newId };
    return this.copyIntoLibrary(chart, p.audioPath, []);
  }

  cancelPending(pendingId: string): void {
    this.pending.delete(pendingId);
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
  }

  private async allocateNewId(base: string): Promise<string> {
    const existing = new Set((await this.library.list()).map((e) => e.trackId));
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base.slice(0, 60)}-${i}`;
      if (!existing.has(candidate) && isValidTrackId(candidate)) return candidate;
    }
    throw new Error('別IDを割り当てられません');
  }

  private async copyIntoLibrary(chart: ChartFile, audioPath: string, warnings: ChartIssue[]): Promise<ImportResult> {
    const dirName = libraryDirName(chart.trackId, chart.audioSha256);
    const targetDir = path.join(this.library.rootDir, dirName);
    const tmpDir = `${targetDir}.importing-${process.pid}-${Date.now()}`;
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      await fsp.mkdir(tmpDir, { recursive: true });
      const targetAudio = path.join(tmpDir, chart.audioFile);
      await fsp.copyFile(audioPath, targetAudio);
      const copiedSha = await sha256File(targetAudio);
      if (copiedSha !== chart.audioSha256) {
        return { status: 'rejected', errors: ['音声のコピー後にハッシュが一致しませんでした。ディスクの状態を確認してください。'] };
      }
      await atomicWriteFile(path.join(tmpDir, CHART_FILE_NAME), serializeChart(chart));
      // コピー結果をもう一度検証
      const recheck = await verifyChartPackage(tmpDir, nodePackageFs);
      if (!recheck.ok) return { status: 'rejected', errors: recheck.errors.map(issueText) };
      await fsp.rm(targetDir, { recursive: true, force: true });
      await fsp.rename(tmpDir, targetDir);
      const entry = entryFromChart(chart, dirName);
      await this.library.upsert(entry);
      const summary: LibraryEntrySummary = toSummary(entry);
      return { status: 'imported', entry: summary, warnings: warnings.map(issueText) };
    } catch (err) {
      return { status: 'rejected', errors: [`取り込みに失敗しました: ${(err as Error).message}`] };
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function issueText(i: ChartIssue): string {
  return i.path ? `${i.message}（${i.path}）` : i.message;
}

/** 登録済みエントリを再検証する（起動時・選択時） */
export async function reverifyEntry(library: LibraryStore, entry: LibraryEntry): Promise<{ ok: true; chart: ChartFile; audioPath: string } | { ok: false; errors: string[] }> {
  const dir = library.entryDir(entry);
  const r = await verifyChartPackage(dir, nodePackageFs);
  if (!r.ok) {
    const errors = r.errors.map(issueText);
    await library.updateVerification(entry.trackId, entry.audioSha256, errors);
    return { ok: false, errors };
  }
  if (r.pkg.chart.trackId !== entry.trackId || r.pkg.chart.audioSha256 !== entry.audioSha256) {
    const errors = ['ライブラリ内の chart.json が登録情報と一致しません。'];
    await library.updateVerification(entry.trackId, entry.audioSha256, errors);
    return { ok: false, errors };
  }
  if (!entry.verified.ok) await library.updateVerification(entry.trackId, entry.audioSha256, []);
  return { ok: true, chart: r.pkg.chart, audioPath: r.pkg.audioPath };
}
