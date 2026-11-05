import { AUDIO_LIMITS, LEVEL_KEYS, chartLevelSchema, chorusSectionSchema, type LevelKey } from '@autobeats/chart-format';
import { atomicWriteFile, readTextFileLimited } from '@autobeats/chart-format/node';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { EditorDocument, ViewState } from '../../shared/types';

export const PROJECT_FORMAT = 'autobeats-rhythm-project' as const;
export const PROJECT_FORMAT_VERSION = 1 as const;
export const PROJECT_EXTENSION = '.rhythm-project.json';
const MAX_PROJECT_BYTES = 200 * 1024 * 1024;

const levelSettingsSchema = z.object({
  density: z.number().min(0).max(1),
  minGapMs: z.number().int().min(1).max(10000),
  chorusDensityMultiplier: z.number().min(1).max(5),
  beatSnapStrength: z.number().min(0).max(1),
});

const analysisSchema = z
  .object({
    engineVersion: z.string(),
    analyzedAt: z.string(),
    durationMs: z.number().int().positive(),
    sampleRate: z.number().positive(),
    bpm: z.number(),
    bpmConfidence: z.number(),
    offsetMs: z.number().int(),
    beatsPerBar: z.number().int(),
    beats: z.array(z.number().int()),
    downbeats: z.array(z.number().int()),
    onsets: z.array(z.object({ timeMs: z.number().int(), strength: z.number() })),
    sections: z.array(z.object({ startMs: z.number().int(), endMs: z.number().int(), cluster: z.number().int(), energy: z.number(), repetition: z.number() })),
    choruses: z.array(chorusSectionSchema),
    leadInEndMs: z.number().int(),
    tailStartMs: z.number().int(),
    frameHopMs: z.number(),
    energyCurve: z.array(z.number()),
    energyCurveStepMs: z.number(),
  })
  .nullable();

export const projectAudioSchema = z.object({
  path: z.string().min(1),
  fileName: z.string().min(1),
  extension: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  durationMs: z.number().int().nonnegative(),
  sampleRate: z.number().nonnegative(),
  channels: z.number().int().nonnegative(),
});

const viewSchema = z.object({
  zoomPxPerSec: z.number().positive(),
  scrollMs: z.number().nonnegative(),
  activeLevel: z.enum(['1', '2', '3', '4']),
  visibleLevels: z.object({ '1': z.boolean(), '2': z.boolean(), '3': z.boolean(), '4': z.boolean() }),
  snapEnabled: z.boolean(),
  snapTarget: z.enum(['beat', 'half', 'quarter', 'onset']),
});

export const projectFileSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  formatVersion: z.literal(PROJECT_FORMAT_VERSION),
  savedAt: z.string(),
  title: z.string().max(256),
  artist: z.string().max(256),
  trackId: z.string().max(64),
  audio: projectAudioSchema.nullable(),
  bpm: z.number(),
  offsetMs: z.number().int(),
  analysis: analysisSchema,
  choruses: z.array(chorusSectionSchema).max(AUDIO_LIMITS.maxChoruses),
  levels: z.object({ '1': chartLevelSchema, '2': chartLevelSchema, '3': chartLevelSchema, '4': chartLevelSchema }),
  levelSettings: z.object({ '1': levelSettingsSchema, '2': levelSettingsSchema, '3': levelSettingsSchema, '4': levelSettingsSchema }),
  view: viewSchema.nullable(),
});

export type ProjectFile = z.infer<typeof projectFileSchema>;

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** 文字列を検証して ProjectFile を返す。失敗は日本語メッセージの ProjectError */
export function parseProjectText(text: string): ProjectFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProjectError('プロジェクトファイルを JSON として読み取れません。');
  }
  if (typeof json !== 'object' || json === null) throw new ProjectError('プロジェクトファイルの形式が不正です。');
  const header = json as { format?: unknown; formatVersion?: unknown };
  if (header.format !== PROJECT_FORMAT) throw new ProjectError('AutoBeats のプロジェクトファイルではありません。');
  if (header.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new ProjectError(`プロジェクト形式バージョン ${String(header.formatVersion)} はこのアプリでは非対応です。新しいバージョンのアプリで開いてください。`);
  }
  const parsed = projectFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProjectError(`プロジェクトファイルの構造が不正です（${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}）。`);
  }
  return parsed.data;
}

export async function readProjectFile(filePath: string): Promise<ProjectFile> {
  let text: string;
  try {
    text = await readTextFileLimited(filePath, MAX_PROJECT_BYTES);
  } catch (err) {
    throw new ProjectError(`プロジェクトファイルを読み取れません: ${(err as Error).message}`);
  }
  return parseProjectText(text);
}

export interface BuildProjectInput {
  document: EditorDocument;
  /** main が管理する音声の絶対パス（token から解決済み） */
  audioPath: string | null;
  view: ViewState | null;
}

/** 編集ドキュメントから保存用 ProjectFile を作る */
export function buildProjectFile(input: BuildProjectInput, now = new Date()): ProjectFile {
  const d = input.document;
  const audio =
    d.audio && input.audioPath
      ? {
          path: input.audioPath,
          fileName: d.audio.fileName,
          extension: d.audio.extension,
          sizeBytes: d.audio.sizeBytes,
          mtimeMs: d.audio.mtimeMs,
          sha256: d.audio.sha256,
          durationMs: d.audio.durationMs,
          sampleRate: d.audio.sampleRate,
          channels: d.audio.channels,
        }
      : null;
  const levels = {} as ProjectFile['levels'];
  for (const k of LEVEL_KEYS) {
    levels[k] = {
      displayName: d.levels[k].displayName,
      notes: [...d.levels[k].notes].sort((a, b) => a.hitAtMs - b.hitAtMs).map((n) => ({ ...n })),
    };
  }
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    savedAt: now.toISOString(),
    title: d.title,
    artist: d.artist,
    trackId: d.trackId,
    audio,
    bpm: d.bpm,
    offsetMs: d.offsetMs,
    analysis: d.analysis,
    choruses: [...d.choruses].sort((a, b) => a.startMs - b.startMs).map((c) => ({ ...c })),
    levels,
    levelSettings: d.levelSettings,
    view: input.view,
  };
}

export async function writeProjectFile(filePath: string, project: ProjectFile): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(project, null, 2) + '\n');
}

/** ProjectFile → EditorDocument（audio.token は呼び出し側が埋める） */
export function projectToDocument(p: ProjectFile, audioToken: string, audioDisplayPath: string): EditorDocument {
  const levels = {} as Record<LevelKey, { displayName: string; notes: EditorDocument['levels']['1']['notes'] }>;
  for (const k of LEVEL_KEYS) levels[k] = { displayName: p.levels[k].displayName, notes: p.levels[k].notes.map((n) => ({ ...n })) };
  return {
    title: p.title,
    artist: p.artist,
    trackId: p.trackId,
    audio: p.audio
      ? {
          token: audioToken,
          fileName: p.audio.fileName,
          extension: p.audio.extension,
          sizeBytes: p.audio.sizeBytes,
          mtimeMs: p.audio.mtimeMs,
          sha256: p.audio.sha256,
          displayPath: audioDisplayPath,
          durationMs: p.audio.durationMs,
          sampleRate: p.audio.sampleRate,
          channels: p.audio.channels,
        }
      : null,
    analysis: p.analysis,
    bpm: p.bpm,
    offsetMs: p.offsetMs,
    choruses: p.choruses.map((c) => ({ ...c })),
    levels,
    levelSettings: p.levelSettings,
  };
}

// ---- 最近使ったプロジェクト ----

const recentSchema = z.object({ entries: z.array(z.object({ path: z.string(), openedAt: z.string() })).max(50) });
export interface RecentRecord {
  path: string;
  openedAt: string;
}

export async function readRecentList(userData: string): Promise<RecentRecord[]> {
  const file = path.join(userData, 'recent.json');
  let entries: RecentRecord[] = [];
  try {
    const parsed = recentSchema.safeParse(JSON.parse(await fsp.readFile(file, 'utf8')));
    if (parsed.success) entries = parsed.data.entries;
  } catch {
    entries = [];
  }
  // 存在しないファイルを除外
  const existing: RecentRecord[] = [];
  for (const e of entries) {
    try {
      const s = await fsp.stat(e.path);
      if (s.isFile()) existing.push(e);
    } catch {
      // 除外
    }
  }
  return existing;
}

export async function addRecent(userData: string, projectPath: string, max = 10): Promise<RecentRecord[]> {
  const current = await readRecentList(userData);
  const next = [{ path: projectPath, openedAt: new Date().toISOString() }, ...current.filter((e) => e.path !== projectPath)].slice(0, max);
  await atomicWriteFile(path.join(userData, 'recent.json'), JSON.stringify({ entries: next }, null, 2));
  return next;
}

// ---- 自動保存と復旧 ----

const autosaveEnvelopeSchema = z.object({
  savedAt: z.string(),
  originalPath: z.string().nullable(),
  project: z.unknown(),
});

export interface AutosaveRecord {
  file: string;
  savedAt: string;
  originalPath: string | null;
  project: ProjectFile;
}

export function autosaveDir(userData: string): string {
  return path.join(userData, 'autosave');
}

/** プロジェクトパス（未保存なら null）から自動保存ファイル名のキーを作る */
export function autosaveKey(originalPath: string | null, sessionId: string): string {
  if (!originalPath) return `unsaved-${sessionId}`;
  let h = 2166136261;
  for (let i = 0; i < originalPath.length; i++) {
    h ^= originalPath.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `project-${h.toString(16)}`;
}

export async function writeAutosave(userData: string, key: string, originalPath: string | null, project: ProjectFile): Promise<string> {
  const dir = autosaveDir(userData);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  await atomicWriteFile(file, JSON.stringify({ savedAt: new Date().toISOString(), originalPath, project }));
  return file;
}

export async function listAutosaves(userData: string): Promise<AutosaveRecord[]> {
  const dir = autosaveDir(userData);
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: AutosaveRecord[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const text = await readTextFileLimited(file, MAX_PROJECT_BYTES);
      const env = autosaveEnvelopeSchema.parse(JSON.parse(text));
      const project = projectFileSchema.parse(env.project);
      out.push({ file, savedAt: env.savedAt, originalPath: env.originalPath, project });
    } catch {
      // 壊れた自動保存は無視（削除はしない）
    }
  }
  out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return out;
}

export async function removeAutosave(file: string, userData: string): Promise<void> {
  const dir = autosaveDir(userData);
  const rel = path.relative(dir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ProjectError('自動保存フォルダ外のファイルは削除できません。');
  await fsp.rm(file, { force: true });
}
