import type { AnalysisResult } from '@autobeats/audio-analysis';
import type { ChartLevel, ChartNote, ChorusSection, LevelGenerationSettings, LevelKey, ChartIssue } from '@autobeats/chart-format';

/** renderer が持つ音声メタ情報。絶対パスは含めない（main がトークンで管理する） */
export interface AudioMeta {
  token: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  /** 表示用（省略されたパス） */
  displayPath: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
}

export interface ViewState {
  zoomPxPerSec: number;
  scrollMs: number;
  activeLevel: LevelKey;
  visibleLevels: Record<LevelKey, boolean>;
  snapEnabled: boolean;
  snapTarget: 'beat' | 'half' | 'quarter' | 'onset';
}

/** 編集ドキュメント（Undo/Redo の単位） */
export interface EditorDocument {
  title: string;
  artist: string;
  trackId: string;
  audio: AudioMeta | null;
  analysis: AnalysisResult | null;
  bpm: number;
  offsetMs: number;
  choruses: ChorusSection[];
  levels: Record<LevelKey, ChartLevel>;
  levelSettings: Record<LevelKey, LevelGenerationSettings>;
}

export interface AudioOpenOk {
  ok: true;
  token: string;
  /** ライブラリへ保存された項目の id */
  libraryId?: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
  displayPath: string;
}
export interface AudioOpenError {
  ok: false;
  message: string;
}
export type AudioOpenResult = AudioOpenOk | AudioOpenError | null;

export interface ProjectLoadOk {
  ok: true;
  document: EditorDocument;
  view: ViewState | null;
  projectName: string;
  /** 音声の状態。missing/changed のときは document.audio.token が空文字 */
  audioStatus: 'ok' | 'missing' | 'changed';
  audioMessage?: string;
}
export interface ProjectLoadError {
  ok: false;
  message: string;
}
export type ProjectLoadResult = ProjectLoadOk | ProjectLoadError | null;

export interface ProjectSaveResult {
  ok: boolean;
  projectName?: string;
  message?: string;
  cancelled?: boolean;
}

export interface RecentEntry {
  id: string;
  name: string;
  displayPath: string;
  openedAt: string;
}

export interface RecoveryEntry {
  id: string;
  savedAt: string;
  originalName: string;
  originalDisplayPath: string;
}

export type ExportStatus =
  | { status: 'ok'; displayPath: string; warnings: ChartIssue[] }
  | { status: 'exists'; requestId: string; displayPath: string }
  | { status: 'cancelled' }
  | { status: 'error'; errors: ChartIssue[] };

export interface VerifyPackageResult {
  ok: boolean;
  displayPath?: string;
  errors: ChartIssue[];
  warnings: ChartIssue[];
  chart?: {
    trackId: string;
    title: string;
    audioSha256: string;
    durationMs: number;
    bpm: number;
    choruses: ChorusSection[];
    levels: Record<LevelKey, { displayName: string; notes: ChartNote[] }>;
  };
}

/** ライブラリ一覧の 1 件（renderer 向け。絶対パスは含めない） */
export interface LibraryEntrySummary {
  id: string;
  sha256: string;
  fileName: string;
  title: string;
  artist: string;
  trackId: string;
  durationMs: number;
  bpm: number;
  noteCounts: Record<LevelKey, number>;
  hasProject: boolean;
  importedAt: string;
  updatedAt: string;
  /** 元ファイルの表示用パス */
  originalDisplayPath: string;
}

export type MenuAction = 'new' | 'open' | 'save' | 'saveAs' | 'undo' | 'redo' | 'export' | 'exportJson' | 'verifyPackage' | 'analyze' | 'zoomIn' | 'zoomOut' | 'selectAll';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';
