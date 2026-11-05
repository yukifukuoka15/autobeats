import { LEVEL_KEYS, type LevelKey } from '@autobeats/chart-format';
import { atomicWriteFile, readTextFileLimited, sha256File } from '@autobeats/chart-format/node';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { AudioFileInfo } from './audioFile';
import { parseProjectText, type ProjectFile } from './project';

/**
 * 楽曲ライブラリ。読み込んだ楽曲の音声コピーと、その譜面データ（プロジェクト）をアプリ内（userData/library）へ保存する。
 *   library/index.json
 *   library/<id>/audio.<ext>     元ファイルのバイト列コピー（原本は変更しない）
 *   library/<id>/project.json    最新の編集状態（保存・自動保存のたびに更新）
 * id は音声の SHA-256 先頭 16 文字。同じ音声は 1 件にまとめる。
 */
const libraryEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string(),
  extension: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  originalPath: z.string(),
  title: z.string(),
  artist: z.string(),
  trackId: z.string(),
  durationMs: z.number().int().nonnegative(),
  bpm: z.number(),
  noteCounts: z.object({ '1': z.number().int(), '2': z.number().int(), '3': z.number().int(), '4': z.number().int() }),
  hasProject: z.boolean(),
  importedAt: z.string(),
  updatedAt: z.string(),
});
const libraryIndexSchema = z.object({ version: z.literal(1), entries: z.array(libraryEntrySchema) });

export type LibraryEntry = z.infer<typeof libraryEntrySchema>;
const MAX_INDEX_BYTES = 20 * 1024 * 1024;

export function libraryIdFor(sha256: string): string {
  return sha256.slice(0, 16);
}

export class EditorLibrary {
  constructor(private readonly userData: string) {}

  get dir(): string {
    return path.join(this.userData, 'library');
  }
  private get indexPath(): string {
    return path.join(this.dir, 'index.json');
  }
  entryDir(id: string): string {
    return path.join(this.dir, id);
  }

  async list(): Promise<LibraryEntry[]> {
    const index = await this.readIndex();
    return [...index.entries].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(id: string): Promise<LibraryEntry | undefined> {
    return (await this.readIndex()).entries.find((e) => e.id === id);
  }

  private async readIndex(): Promise<z.infer<typeof libraryIndexSchema>> {
    try {
      const text = await readTextFileLimited(this.indexPath, MAX_INDEX_BYTES);
      const parsed = libraryIndexSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
      // 壊れた索引は退避して空から再構築する（音声・プロジェクトのフォルダは残す）
      await fsp.copyFile(this.indexPath, `${this.indexPath}.corrupt-${Date.now()}`).catch(() => undefined);
    } catch {
      // 未作成
    }
    return { version: 1, entries: [] };
  }

  private async writeIndex(index: z.infer<typeof libraryIndexSchema>): Promise<void> {
    await atomicWriteFile(this.indexPath, JSON.stringify(index, null, 2) + '\n');
  }

  /** ライブラリ内の音声コピーのパス（存在しなければ null） */
  async audioPath(id: string): Promise<string | null> {
    const entry = await this.get(id);
    if (!entry) return null;
    const p = path.join(this.entryDir(id), `audio${entry.extension}`);
    return fsp
      .access(p)
      .then(() => p)
      .catch(() => null);
  }

  /**
   * 読み込んだ音声をライブラリへ保存する（同じ SHA-256 なら再コピーしない）。
   * コピー後にハッシュを再計算して一致を確認する。
   */
  async importAudio(info: AudioFileInfo, now = new Date()): Promise<{ entry: LibraryEntry; audioPath: string; created: boolean }> {
    const id = libraryIdFor(info.sha256);
    const dir = this.entryDir(id);
    const target = path.join(dir, `audio${info.extension}`);
    let created = false;
    const exists = await fsp
      .stat(target)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!exists || (await sha256File(target)) !== info.sha256) {
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await fsp.copyFile(info.path, tmp);
      if ((await sha256File(tmp)) !== info.sha256) {
        await fsp.rm(tmp, { force: true });
        throw new Error('ライブラリへのコピー後のハッシュが一致しません。');
      }
      await fsp.rename(tmp, target);
      created = true;
    }
    const index = await this.readIndex();
    const existing = index.entries.find((e) => e.id === id);
    const entry: LibraryEntry = existing
      ? { ...existing, fileName: info.fileName, originalPath: info.path, sizeBytes: info.sizeBytes, mtimeMs: info.mtimeMs, updatedAt: now.toISOString() }
      : {
          id,
          sha256: info.sha256,
          fileName: info.fileName,
          extension: info.extension,
          sizeBytes: info.sizeBytes,
          mtimeMs: info.mtimeMs,
          originalPath: info.path,
          title: info.fileName.replace(/\.[^.]+$/, ''),
          artist: '',
          trackId: '',
          durationMs: 0,
          bpm: 0,
          noteCounts: { '1': 0, '2': 0, '3': 0, '4': 0 },
          hasProject: false,
          importedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
    index.entries = [...index.entries.filter((e) => e.id !== id), entry];
    await this.writeIndex(index);
    return { entry, audioPath: target, created };
  }

  /** 最新の編集状態をライブラリへ保存し、一覧用の情報を更新する */
  async saveProject(id: string, project: ProjectFile, now = new Date()): Promise<LibraryEntry | null> {
    const index = await this.readIndex();
    const existing = index.entries.find((e) => e.id === id);
    if (!existing) return null;
    await fsp.mkdir(this.entryDir(id), { recursive: true });
    await atomicWriteFile(path.join(this.entryDir(id), 'project.json'), JSON.stringify(project, null, 2) + '\n');
    const noteCounts = {} as Record<LevelKey, number>;
    for (const k of LEVEL_KEYS) noteCounts[k] = project.levels[k].notes.length;
    const entry: LibraryEntry = {
      ...existing,
      title: project.title || existing.title,
      artist: project.artist,
      trackId: project.trackId,
      durationMs: project.audio?.durationMs ?? existing.durationMs,
      bpm: project.bpm,
      noteCounts,
      hasProject: true,
      updatedAt: now.toISOString(),
    };
    index.entries = index.entries.map((e) => (e.id === id ? entry : e));
    await this.writeIndex(index);
    return entry;
  }

  async readProject(id: string): Promise<ProjectFile | null> {
    try {
      const text = await readTextFileLimited(path.join(this.entryDir(id), 'project.json'), 200 * 1024 * 1024);
      return parseProjectText(text);
    } catch {
      return null;
    }
  }

  /** 項目を削除する（音声コピーとプロジェクトも消す。原本には触れない） */
  async remove(id: string): Promise<boolean> {
    const index = await this.readIndex();
    if (!index.entries.some((e) => e.id === id)) return false;
    index.entries = index.entries.filter((e) => e.id !== id);
    await this.writeIndex(index);
    await fsp.rm(this.entryDir(id), { recursive: true, force: true });
    return true;
  }
}
