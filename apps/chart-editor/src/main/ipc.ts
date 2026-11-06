import { createEmptyDocument } from '../renderer/src/store/document';
import { CHART_FILE_NAME, LEVEL_KEYS, sanitizeTrackId, verifyChartPackage, chartLevelSchema, chorusSectionSchema } from '@autobeats/chart-format';
import { nodePackageFs } from '@autobeats/chart-format/node';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type {
  AudioOpenResult,
  EditorDocument,
  ExportStatus,
  LibraryEntrySummary,
  ProjectLoadResult,
  ProjectSaveResult,
  RecentEntry,
  RecoveryEntry,
  UnsavedChoice,
  VerifyPackageResult,
  ViewState,
} from '../shared/types';
import { registerAudioPath, resolveAudioToken } from './media';
import { downloadYoutube } from './services/youtube';
import { AudioFileError, displayPath, inspectAudioFile } from './services/audioFile';
import { exportChartJson, exportGamePackage, minGapMapFromDocument } from './services/exportPackage';
import { EditorLibrary, libraryIdFor, type LibraryEntry } from './services/library';
import {
  PROJECT_EXTENSION,
  ProjectError,
  addRecent,
  autosaveKey,
  buildProjectFile,
  listAutosaves,
  projectToDocument,
  readProjectFile,
  readRecentList,
  removeAutosave,
  writeAutosave,
  writeProjectFile,
  type ProjectFile,
} from './services/project';

// ---- renderer から受け取る値のスキーマ ----
const audioMetaSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{32}$|^$/),
  fileName: z.string(),
  extension: z.string(),
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  displayPath: z.string(),
  durationMs: z.number().int().nonnegative(),
  sampleRate: z.number().nonnegative(),
  channels: z.number().int().nonnegative(),
});
const levelSettingsSchema = z.object({ density: z.number(), minGapMs: z.number(), chorusDensityMultiplier: z.number(), beatSnapStrength: z.number() });
const documentSchema = z.object({
  noteMode: z.enum(['independent', 'additive']).optional(),
  title: z.string().max(256),
  artist: z.string().max(256),
  trackId: z.string().max(64),
  audio: audioMetaSchema.nullable(),
  analysis: z.unknown(),
  bpm: z.number(),
  offsetMs: z.number(),
  choruses: z.array(chorusSectionSchema),
  levels: z.object({ '1': chartLevelSchema, '2': chartLevelSchema, '3': chartLevelSchema, '4': chartLevelSchema }),
  levelSettings: z.object({ '1': levelSettingsSchema, '2': levelSettingsSchema, '3': levelSettingsSchema, '4': levelSettingsSchema }),
});
const viewSchema = z
  .object({
    zoomPxPerSec: z.number(),
    scrollMs: z.number(),
    activeLevel: z.enum(['1', '2', '3', '4']),
    visibleLevels: z.object({ '1': z.boolean(), '2': z.boolean(), '3': z.boolean(), '4': z.boolean() }),
    snapEnabled: z.boolean(),
    snapTarget: z.enum(['beat', 'half', 'quarter', 'onset']),
  })
  .nullable();

interface SessionState {
  projectPath: string | null;
  dirty: boolean;
  sessionId: string;
  /** id → 絶対パス（最近・復旧の選択用。renderer には id だけ渡す） */
  recentIds: Map<string, string>;
  recoveryIds: Map<string, string>;
  exportRequests: Map<string, { parentDir: string }>;
}

export const session: SessionState = {
  projectPath: null,
  dirty: false,
  sessionId: randomBytes(4).toString('hex'),
  recentIds: new Map(),
  recoveryIds: new Map(),
  exportRequests: new Map(),
};

function userData(): string {
  return app.getPath('userData');
}

let libraryInstance: EditorLibrary | null = null;
function library(): EditorLibrary {
  if (!libraryInstance) libraryInstance = new EditorLibrary(userData());
  return libraryInstance;
}

function toSummary(e: LibraryEntry): LibraryEntrySummary {
  return {
    id: e.id,
    sha256: e.sha256,
    fileName: e.fileName,
    title: e.title,
    artist: e.artist,
    trackId: e.trackId,
    durationMs: e.durationMs,
    bpm: e.bpm,
    noteCounts: e.noteCounts,
    hasProject: e.hasProject,
    importedAt: e.importedAt,
    updatedAt: e.updatedAt,
    originalDisplayPath: displayPath(e.originalPath),
  };
}

/** 楽曲が読み込まれているドキュメントの最新状態をライブラリへ写す */
async function syncLibraryProject(doc: EditorDocument, project: ProjectFile): Promise<void> {
  if (!doc.audio) return;
  try {
    await library().saveProject(libraryIdFor(doc.audio.sha256), project);
  } catch (err) {
    console.warn('library sync failed', err);
  }
}

function parseDocument(raw: unknown): EditorDocument {
  return documentSchema.parse(raw) as EditorDocument;
}

export async function loadProjectFromPath(filePath: string): Promise<ProjectLoadResult> {
  let project: ProjectFile;
  try {
    project = await readProjectFile(filePath);
  } catch (err) {
    return { ok: false, message: err instanceof ProjectError ? err.message : `プロジェクトを開けません: ${(err as Error).message}` };
  }
  return projectToLoadResult(project, path.basename(filePath, PROJECT_EXTENSION), filePath);
}

async function projectToLoadResult(project: ProjectFile, projectName: string, projectPath: string | null): Promise<ProjectLoadResult> {
  let audioStatus: 'ok' | 'missing' | 'changed' = 'ok';
  let audioMessage: string | undefined;
  let token = '';
  let display = '';
  if (project.audio) {
    try {
      const info = await inspectAudioFile(project.audio.path);
      if (info.sha256 !== project.audio.sha256) {
        audioStatus = 'changed';
        audioMessage = `音声ファイル "${project.audio.fileName}" の内容がプロジェクト保存時から変わっています（SHA-256 不一致）。元のファイルを指定し直してください。`;
      } else {
        token = registerAudioPath(info.path);
        display = displayPath(info.path);
      }
    } catch (err) {
      audioStatus = 'missing';
      audioMessage = `音声ファイル "${project.audio.fileName}" を読み込めません（${err instanceof AudioFileError ? err.message : (err as Error).message}）。ファイルを指定し直してください。`;
    }
  }
  session.projectPath = projectPath;
  session.dirty = false;
  if (projectPath) await addRecent(userData(), projectPath);
  return { ok: true, document: projectToDocument(project, token, display), view: project.view, projectName, audioStatus, audioMessage };
}

function getWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

export function registerIpc(rebuildMenu: () => Promise<void>): void {
  ipcMain.handle('app:ping', () => 'pong');

  let youtubeBusy = false;
  ipcMain.handle('audio:youtube', async (_event, raw: unknown): Promise<AudioOpenResult> => {
    if (youtubeBusy) return { ok: false, message: 'YouTube の取り込み中です。完了をお待ちください。' };
    let temp: string | undefined;
    youtubeBusy = true;
    try {
      const text = z.string().min(1).max(4096).parse(raw);
      const base = path.join(userData(), 'youtube-imports');
      await fsp.mkdir(base, { recursive: true });
      temp = await fsp.mkdtemp(path.join(base, 'import-'));
      const scripts = app.isPackaged ? path.join(process.resourcesPath, 'youtube') : path.join(app.getAppPath(), 'resources', 'youtube');
      const file = await downloadYoutube(text, scripts, temp, app.isPackaged ? path.join(process.resourcesPath, 'youtube-runtime') : undefined);
      const result = await openAudioPath(file);
      // コピーに失敗した場合は再生元のファイルを保持する。
      if (result?.ok && !result.libraryId) temp = undefined;
      return result;
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    } finally {
      youtubeBusy = false;
      if (temp) await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  ipcMain.handle('audio:openDialog', async (event): Promise<AudioOpenResult> => {
    const win = getWindow(event);
    const r = await dialog.showOpenDialog(win!, {
      title: '楽曲ファイルを選択',
      properties: ['openFile'],
      filters: [{ name: '音声ファイル', extensions: ['mp3', 'wav', 'm4a', 'ogg'] }],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return openAudioPath(r.filePaths[0]!);
  });

  ipcMain.handle('project:new', () => {
    session.projectPath = null;
    session.dirty = false;
    return { ok: true };
  });

  ipcMain.handle('project:openDialog', async (event): Promise<ProjectLoadResult> => {
    const r = await dialog.showOpenDialog(getWindow(event)!, {
      title: 'プロジェクトを開く',
      properties: ['openFile'],
      filters: [{ name: 'AutoBeats プロジェクト', extensions: ['json'] }],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    const result = await loadProjectFromPath(r.filePaths[0]!);
    await rebuildMenu();
    return result;
  });

  ipcMain.handle('project:save', async (event, rawDoc: unknown, rawView: unknown, opts: unknown): Promise<ProjectSaveResult> => {
    const doc = parseDocument(rawDoc);
    const view = viewSchema.parse(rawView) as ViewState | null;
    const { saveAs } = z.object({ saveAs: z.boolean().optional() }).parse(opts ?? {});
    let target = session.projectPath;
    if (!target || saveAs) {
      const r = await dialog.showSaveDialog(getWindow(event)!, {
        title: '名前を付けて保存',
        defaultPath: `${doc.title || doc.trackId || 'untitled'}${PROJECT_EXTENSION}`,
        filters: [{ name: 'AutoBeats プロジェクト', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
      target = r.filePath.endsWith(PROJECT_EXTENSION) ? r.filePath : r.filePath.replace(/\.json$/, '') + PROJECT_EXTENSION;
    }
    const audioPath = doc.audio?.token ? resolveAudioToken(doc.audio.token) : null;
    const project = buildProjectFile({ document: doc, audioPath, view });
    try {
      await writeProjectFile(target, project);
    } catch (err) {
      return { ok: false, message: `保存に失敗しました: ${(err as Error).message}` };
    }
    await syncLibraryProject(doc, project);
    session.projectPath = target;
    session.dirty = false;
    await addRecent(userData(), target);
    await rebuildMenu();
    return { ok: true, projectName: path.basename(target, PROJECT_EXTENSION) };
  });

  ipcMain.handle('project:state', () => ({ projectName: session.projectPath ? path.basename(session.projectPath, PROJECT_EXTENSION) : null }));

  ipcMain.handle('project:setDirty', (_e, dirty: unknown) => {
    session.dirty = z.boolean().parse(dirty);
  });

  ipcMain.handle('project:confirmUnsaved', async (event, message: unknown): Promise<UnsavedChoice> => {
    const r = await dialog.showMessageBox(getWindow(event)!, {
      type: 'warning',
      message: z.string().max(500).parse(message ?? '未保存の変更があります。'),
      detail: '保存しますか？',
      buttons: ['保存', '保存しない', 'キャンセル'],
      defaultId: 0,
      cancelId: 2,
    });
    return r.response === 0 ? 'save' : r.response === 1 ? 'discard' : 'cancel';
  });

  ipcMain.handle('recent:list', async (): Promise<RecentEntry[]> => {
    const list = await readRecentList(userData());
    session.recentIds.clear();
    return list.map((r, i) => {
      const id = `r${i}-${randomBytes(4).toString('hex')}`;
      session.recentIds.set(id, r.path);
      return { id, name: path.basename(r.path, PROJECT_EXTENSION), displayPath: displayPath(r.path), openedAt: r.openedAt };
    });
  });

  ipcMain.handle('recent:open', async (_e, id: unknown): Promise<ProjectLoadResult> => {
    const p = session.recentIds.get(z.string().parse(id));
    if (!p) return { ok: false, message: '最近使ったプロジェクトの項目が見つかりません。' };
    const result = await loadProjectFromPath(p);
    await rebuildMenu();
    return result;
  });

  ipcMain.handle('autosave:write', async (_e, rawDoc: unknown, rawView: unknown) => {
    const doc = parseDocument(rawDoc);
    const view = viewSchema.parse(rawView) as ViewState | null;
    const audioPath = doc.audio?.token ? resolveAudioToken(doc.audio.token) : null;
    const key = autosaveKey(session.projectPath, session.sessionId);
    const project = buildProjectFile({ document: doc, audioPath, view });
    await writeAutosave(userData(), key, session.projectPath, project);
    await syncLibraryProject(doc, project);
    return { ok: true };
  });

  ipcMain.handle('autosave:clearCurrent', async () => {
    const key = autosaveKey(session.projectPath, session.sessionId);
    const file = path.join(userData(), 'autosave', `${key}.json`);
    await fsp.rm(file, { force: true });
  });

  ipcMain.handle('recovery:list', async (): Promise<RecoveryEntry[]> => {
    const list = await listAutosaves(userData());
    session.recoveryIds.clear();
    return list.map((r, i) => {
      const id = `a${i}-${randomBytes(4).toString('hex')}`;
      session.recoveryIds.set(id, r.file);
      return {
        id,
        savedAt: r.savedAt,
        originalName: r.originalPath ? path.basename(r.originalPath, PROJECT_EXTENSION) : r.project.title || '（未保存のプロジェクト）',
        originalDisplayPath: r.originalPath ? displayPath(r.originalPath) : '（未保存）',
      };
    });
  });

  ipcMain.handle('recovery:open', async (_e, id: unknown): Promise<ProjectLoadResult> => {
    const file = session.recoveryIds.get(z.string().parse(id));
    if (!file) return { ok: false, message: '復旧データが見つかりません。' };
    const all = await listAutosaves(userData());
    const rec = all.find((r) => r.file === file);
    if (!rec) return { ok: false, message: '復旧データを読み込めません。' };
    // 元プロジェクトは無断で上書きしない: projectPath は元の場所を指すが dirty=true として扱う
    const result = await projectToLoadResult(rec.project, rec.originalPath ? `${path.basename(rec.originalPath, PROJECT_EXTENSION)}（復旧）` : '復旧プロジェクト', rec.originalPath);
    session.dirty = true;
    await removeAutosave(file, userData());
    return result;
  });

  ipcMain.handle('recovery:discard', async (_e, id: unknown) => {
    const file = session.recoveryIds.get(z.string().parse(id));
    if (file) await removeAutosave(file, userData());
    return { ok: true };
  });

  ipcMain.handle('audio:relocateDialog', async (event): Promise<AudioOpenResult> => {
    const r = await dialog.showOpenDialog(getWindow(event)!, {
      title: '音声ファイルを指定し直す',
      properties: ['openFile'],
      filters: [{ name: '音声ファイル', extensions: ['mp3', 'wav', 'm4a', 'ogg'] }],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return openAudioPath(r.filePaths[0]!);
  });

  ipcMain.handle('export:package', async (event, rawDoc: unknown, rawOpts: unknown): Promise<ExportStatus> => {
    const doc = parseDocument(rawDoc);
    const opts = z.object({ requestId: z.string().optional(), mode: z.enum(['ask', 'overwrite', 'rename']).default('ask') }).parse(rawOpts ?? {});
    const audioPath = doc.audio?.token ? resolveAudioToken(doc.audio.token) : null;
    if (!audioPath) return { status: 'error', errors: [{ code: 'no-audio', message: '楽曲が読み込まれていません。' }] };
    let parentDir: string;
    if (opts.requestId) {
      const req = session.exportRequests.get(opts.requestId);
      if (!req) return { status: 'error', errors: [{ code: 'request', message: '書き出し要求が見つかりません。' }] };
      parentDir = req.parentDir;
      session.exportRequests.delete(opts.requestId);
    } else {
      const r = await dialog.showOpenDialog(getWindow(event)!, {
        title: 'ゲーム用フォルダの書き出し先（この中に楽曲IDのフォルダを作ります）',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || r.filePaths.length === 0) return { status: 'cancelled' };
      parentDir = r.filePaths[0]!;
    }
    const result = await exportGamePackage(doc, audioPath, parentDir, opts.mode);
    if (result.status === 'exists') {
      const requestId = randomBytes(6).toString('hex');
      session.exportRequests.set(requestId, { parentDir });
      return { status: 'exists', requestId, displayPath: displayPath(result.dir) };
    }
    if (result.status === 'ok') return { status: 'ok', displayPath: displayPath(result.dir), warnings: result.warnings };
    return result;
  });

  ipcMain.handle('export:chartJson', async (event, rawDoc: unknown) => {
    const doc = parseDocument(rawDoc);
    const r = await dialog.showSaveDialog(getWindow(event)!, { title: '譜面JSONを書き出し', defaultPath: CHART_FILE_NAME, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { status: 'cancelled' as const };
    const result = await exportChartJson(doc, r.filePath);
    if (!result.ok) return { status: 'error' as const, errors: result.errors };
    return { status: 'ok' as const, displayPath: displayPath(r.filePath), warnings: result.warnings };
  });

  ipcMain.handle('package:verifyDialog', async (event, rawDoc: unknown): Promise<VerifyPackageResult | null> => {
    const doc = rawDoc ? parseDocument(rawDoc) : null;
    const r = await dialog.showOpenDialog(getWindow(event)!, {
      title: '書き出したフォルダ（chart.json を含む）を選択',
      properties: ['openDirectory'],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    const dir = r.filePaths[0]!;
    // 読み込み用の検証: 難易度間衝突はエラーにせず、読み込み後に修復方法を選ばせる
    const result = await verifyChartPackage(dir, nodePackageFs, doc ? { minGapMsByLevel: minGapMapFromDocument(doc) } : {});
    if (!result.ok) return { ok: false, displayPath: displayPath(dir), errors: result.errors, warnings: result.warnings };
    const c = result.pkg.chart;
    const levels = {} as VerifyPackageResult['chart'] extends infer T ? (T extends { levels: infer L } ? L : never) : never;
    for (const k of LEVEL_KEYS) (levels as Record<string, unknown>)[k] = c.levels[k];
    return {
      ok: true,
      displayPath: displayPath(dir),
      errors: [],
      warnings: result.pkg.warnings,
      chart: { generationRules: c.generationRules, trackId: c.trackId, title: c.title, audioSha256: c.audioSha256, durationMs: c.durationMs, bpm: c.bpm, choruses: c.choruses, levels },
    };
  });

  // ---- 楽曲ライブラリ ----
  ipcMain.handle('library:list', async (): Promise<LibraryEntrySummary[]> => (await library().list()).map(toSummary));

  ipcMain.handle('library:open', async (_e, rawId: unknown): Promise<ProjectLoadResult> => {
    const id = z.string().regex(/^[0-9a-f]{16}$/).parse(rawId);
    const entry = await library().get(id);
    if (!entry) return { ok: false, message: 'ライブラリの項目が見つかりません。' };
    const audioPath = await library().audioPath(id);
    if (!audioPath) return { ok: false, message: 'ライブラリ内の音声ファイルが見つかりません。元のファイルから読み込み直してください。' };
    const project = await library().readProject(id);
    if (project) {
      // ライブラリの音声コピーを使う（元ファイルが移動していても開ける）
      const result = await projectToLoadResult({ ...project, audio: project.audio ? { ...project.audio, path: audioPath } : null }, entry.title || entry.fileName, null);
      return result;
    }
    // 譜面データがまだない場合は音声だけのドキュメントを返す
    const info = await inspectAudioFile(audioPath);
    const token = registerAudioPath(info.path);
    session.projectPath = null;
    session.dirty = false;
    const empty = buildProjectFile({ document: emptyDocumentWithTitle(entry.title), audioPath: null, view: null });
    const document = projectToDocument(empty, '', '');
    document.audio = { token, fileName: entry.fileName, extension: entry.extension, sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs, sha256: entry.sha256, displayPath: displayPath(entry.originalPath), durationMs: 0, sampleRate: 0, channels: 0 };
    return { ok: true, document, view: null, projectName: entry.title || entry.fileName, audioStatus: 'ok' };
  });

  ipcMain.handle('library:remove', async (event, rawId: unknown): Promise<{ ok: boolean; message?: string }> => {
    const id = z.string().regex(/^[0-9a-f]{16}$/).parse(rawId);
    const entry = await library().get(id);
    if (!entry) return { ok: false, message: '項目が見つかりません。' };
    const r = await dialog.showMessageBox(getWindow(event)!, {
      type: 'warning',
      message: `「${entry.title || entry.fileName}」をライブラリから削除しますか？`,
      detail: 'アプリ内に保存した音声コピーと譜面データを削除します。元の音声ファイルや保存済みの .rhythm-project.json は削除しません。',
      buttons: ['削除', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
    });
    if (r.response !== 0) return { ok: false };
    await library().remove(id);
    return { ok: true };
  });

  ipcMain.handle('app:showError', async (event, title: unknown, message: unknown) => {
    await dialog.showMessageBox(getWindow(event)!, { type: 'error', message: z.string().parse(title), detail: z.string().parse(message) });
  });

}

/**
 * 音声ファイルを検査し、ライブラリ（アプリ内）へコピーしてから、そのコピーを再生用に登録する。
 * 原本は読むだけで変更しない。ライブラリへのコピーに失敗した場合は原本をそのまま使う。
 */
export async function openAudioPath(filePath: string): Promise<AudioOpenResult> {
  try {
    const info = await inspectAudioFile(filePath);
    let playbackPath = info.path;
    let libraryId: string | undefined;
    try {
      const imported = await library().importAudio(info);
      playbackPath = imported.audioPath;
      libraryId = imported.entry.id;
    } catch (err) {
      console.warn('library import failed', err);
    }
    const token = registerAudioPath(playbackPath);
    return { ok: true, token, libraryId, fileName: info.fileName, extension: info.extension, sizeBytes: info.sizeBytes, mtimeMs: info.mtimeMs, sha256: info.sha256, displayPath: displayPath(info.path) };
  } catch (err) {
    return { ok: false, message: err instanceof AudioFileError ? err.message : `音声ファイルを読み込めません: ${(err as Error).message}` };
  }
}

function emptyDocumentWithTitle(title: string): EditorDocument {
  return { ...createEmptyDocument(), title, trackId: sanitizeTrackId(title, 'track') };
}
