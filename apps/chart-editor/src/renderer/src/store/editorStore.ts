import type { AnalysisResult, AnalysisStage, ManualNotePolicy, WaveformPeaks } from '@autobeats/audio-analysis';
import { LEVEL_KEYS, type LevelGenerationSettings, type LevelKey, type LevelPairKey } from '@autobeats/chart-format';
import { useSyncExternalStore } from 'react';
import type { AudioMeta, EditorDocument, LibraryEntrySummary, VerifyPackageResult, ViewState } from '../../../shared/types';
import * as cmd from './document';
import { canRedo, canUndo, commit, createHistory, isDirty, markSaved, present, redo, redoLabel, undo, undoLabel, type History } from './history';

export type SnapTarget = ViewState['snapTarget'];

export type Selection = { kind: 'notes'; level: LevelKey; ids: ReadonlySet<string> } | { kind: 'chorus'; id: string } | null;

export interface AnalysisJobState {
  jobId: number;
  status: 'idle' | 'decoding' | 'running' | 'done' | 'cancelled' | 'error';
  stage: AnalysisStage | 'decode' | 'peaks';
  ratio: number;
  message: string;
}

export interface LoopState {
  enabled: boolean;
  startMs: number;
  endMs: number;
}

export interface PlaybackPrefs {
  rate: 0.5 | 0.75 | 1 | 1.25;
  metronome: boolean;
  preview: boolean;
  volumeSong: number;
  volumeMetronome: number;
  volumePreview: number;
}

export type DialogState =
  | { kind: 'none' }
  | { kind: 'regenerate'; reason: 'chorus' | 'analysis' | 'settings' }
  | { kind: 'overlap' }
  | { kind: 'export-exists'; requestId: string; displayPath: string }
  | { kind: 'export-result'; ok: boolean; title: string; lines: string[] }
  | { kind: 'recovery'; entries: { id: string; savedAt: string; originalName: string; originalDisplayPath: string }[] }
  | { kind: 'verify-result'; ok: boolean; displayPath: string; lines: string[]; canImport: boolean; chart: NonNullable<VerifyPackageResult['chart']> | null }
  | { kind: 'message'; title: string; lines: string[] }
  /** 読み込んだ譜面に難易度間衝突がある */
  | { kind: 'conflicts'; total: number; byPair: Record<LevelPairKey, number>; source: string };

export interface EditorState {
  history: History<EditorDocument>;
  view: ViewState;
  selection: Selection;
  analysis: AnalysisJobState;
  loop: LoopState;
  playback: PlaybackPrefs;
  projectName: string | null;
  audioLoaded: boolean;
  /** 波形ピークの世代（再描画トリガ） */
  peaksVersion: number;
  dialog: DialogState;
  status: { kind: 'info' | 'warn' | 'error'; text: string } | null;
  /** ドラッグ中の一時オフセット（コミット前のプレビュー）。conflict は難易度間衝突などで確定できない状態 */
  dragPreview: { kind: 'notes'; level: LevelKey; ids: ReadonlySet<string>; deltaMs: number; conflict: boolean } | { kind: 'chorus'; id: string; startMs: number; endMs: number } | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number } | { kind: 'new-chorus'; startMs: number; endMs: number } | null;
  /** 衝突を含む譜面を「読み取り専用で確認」中。ヒット編集を拒否する */
  readOnly: boolean;
  /** 直近の生成で目標ヒット数に達しなかったレベルの警告（再生成・解析で更新） */
  generationWarnings: string[];
  /** キーボードスクラブの状態（編集データではないので履歴に入らない） */
  scrub: { active: boolean; holding: boolean; direction: 1 | -1; timeMs: number };
  /** プレイテスト画面（Q/W/O/P で 4 レーン同時試奏）の表示 */
  playtest: { open: boolean };
  /** 楽曲ライブラリ（アプリ内に保存した楽曲と譜面データ） */
  library: LibraryEntrySummary[];
  /** F 長押し中の連打プレビュー（開始時刻と編集中レベル） */
  mashPreview: { level: LevelKey; startMs: number } | null;
}

export const DEFAULT_VIEW: ViewState = {
  zoomPxPerSec: 60,
  scrollMs: 0,
  activeLevel: '1',
  visibleLevels: { '1': true, '2': true, '3': true, '4': true },
  snapEnabled: true,
  snapTarget: 'beat',
};

/** 非シリアライズのランタイム（AudioBuffer・ピーク） */
export const runtime: { audioBuffer: AudioBuffer | null; peaks: WaveformPeaks | null } = { audioBuffer: null, peaks: null };

type Listener = () => void;

class EditorStore {
  private state: EditorState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = {
      history: createHistory(cmd.createEmptyDocument()),
      view: { ...DEFAULT_VIEW },
      selection: null,
      analysis: { jobId: 0, status: 'idle', stage: 'prepare', ratio: 0, message: '' },
      loop: { enabled: false, startMs: 0, endMs: 0 },
      playback: { rate: 1, metronome: false, preview: false, volumeSong: 0.9, volumeMetronome: 0.6, volumePreview: 0.6 },
      projectName: null,
      audioLoaded: false,
      peaksVersion: 0,
      dialog: { kind: 'none' },
      status: null,
      dragPreview: null,
      readOnly: false,
      generationWarnings: [],
      scrub: { active: false, holding: false, direction: 1, timeMs: 0 },
      playtest: { open: false },
      library: [],
      mashPreview: null,
    };
  }

  getState = (): EditorState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ---- ドキュメント ----
  get doc(): EditorDocument {
    return present(this.state.history);
  }

  commitDoc(next: EditorDocument, label: string): void {
    if (next === this.doc) return;
    this.set({ history: commit(this.state.history, next, label) });
  }

  replaceDocument(doc: EditorDocument, options: { projectName: string | null; view?: ViewState | null; dirty?: boolean }): void {
    let history = createHistory(doc);
    if (options.dirty) history = { ...history, savedIndex: -1 };
    this.set({
      history,
      selection: null,
      projectName: options.projectName,
      view: { ...DEFAULT_VIEW, ...options.view, activeLevel: options.view?.activeLevel === '4' ? '1' : (options.view?.activeLevel ?? '1') },
      loop: { enabled: false, startMs: 0, endMs: 0 },
      analysis: { jobId: this.state.analysis.jobId, status: 'idle', stage: 'prepare', ratio: 0, message: '' },
      dragPreview: null,
      readOnly: false,
      generationWarnings: [],
    });
  }

  undo(): void {
    if (!canUndo(this.state.history)) return;
    this.set({ history: undo(this.state.history), selection: null, dragPreview: null });
  }
  redo(): void {
    if (!canRedo(this.state.history)) return;
    this.set({ history: redo(this.state.history), selection: null, dragPreview: null });
  }
  get canUndo(): boolean {
    return canUndo(this.state.history);
  }
  get canRedo(): boolean {
    return canRedo(this.state.history);
  }
  get undoLabel(): string | null {
    return undoLabel(this.state.history);
  }
  get redoLabel(): string | null {
    return redoLabel(this.state.history);
  }
  get dirty(): boolean {
    return isDirty(this.state.history);
  }
  markSaved(projectName: string | null): void {
    this.set({ history: markSaved(this.state.history), projectName });
  }

  // ---- 編集コマンド ----
  setAudio(meta: AudioMeta): void {
    this.commitDoc(cmd.documentWithAudio(this.doc, meta), '楽曲を読み込み');
    this.set({ selection: null, loop: { enabled: false, startMs: 0, endMs: Math.min(meta.durationMs, 10000) } });
  }
  setMeta(patch: Partial<Pick<EditorDocument, 'title' | 'artist' | 'trackId' | 'bpm' | 'offsetMs'>>): void {
    this.commitDoc({ ...this.doc, ...patch }, 'プロジェクト情報を変更');
  }
  /** 編集結果を反映する共通処理。拒否時は履歴へ積まず理由を表示する */
  private applyEdit(result: cmd.EditResult, label: string): boolean {
    if (this.state.readOnly) {
      this.set({ status: { kind: 'error', text: '読み取り専用で確認中です。編集するには「衝突を修復」または「4レベルを再生成」を実行してください。' } });
      return false;
    }
    if (!result.ok) {
      this.set({ status: { kind: 'error', text: result.message.replace(/\n/g, ' ') } });
      return false;
    }
    this.commitDoc(result.doc, label);
    if (result.warnings.length > 0) this.set({ status: { kind: 'warn', text: result.warnings[0]! } });
    return true;
  }
  /** 直近の編集拒否・警告メッセージを消す */
  clearStatus(): void {
    if (this.state.status) this.set({ status: null });
  }
  addNote(level: LevelKey, hitAtMs: number): string | null {
    const r = cmd.addNote(this.doc, level, hitAtMs);
    if (!this.applyEdit(r, 'ヒットを追加')) return null;
    const id = (r as { id: string }).id;
    this.set({ selection: { kind: 'notes', level, ids: new Set([id]) } });
    return id;
  }
  addMash(level: LevelKey, startMs: number, endMs: number): string | null {
    const r = cmd.addMash(this.doc, level, startMs, endMs);
    if (!this.applyEdit(r, '連打を追加')) return null;
    const id = (r as { id: string }).id;
    this.set({ selection: { kind: 'notes', level, ids: new Set([id]) } });
    return id;
  }
  setNoteDuration(level: LevelKey, id: string, durationMs: number): boolean {
    return this.applyEdit(cmd.setNoteDuration(this.doc, level, id, durationMs), '連打の長さを変更');
  }
  setNoteType(level: LevelKey, id: string, type: 'tap' | 'mash'): boolean {
    return this.applyEdit(cmd.setNoteType(this.doc, level, id, type), type === 'mash' ? '連打に変更' : '通常ヒットに変更');
  }
  setMashPreview(mashPreview: EditorState['mashPreview']): void {
    this.set({ mashPreview });
  }
  moveSelectedNotes(deltaMs: number): boolean {
    const sel = this.state.selection;
    if (!sel || sel.kind !== 'notes') return false;
    return this.applyEdit(cmd.moveNotes(this.doc, sel.level, sel.ids, deltaMs), sel.ids.size > 1 ? '複数ヒットを移動' : 'ヒットを移動');
  }
  setNoteTime(level: LevelKey, id: string, hitAtMs: number): boolean {
    return this.applyEdit(cmd.setNoteTime(this.doc, level, id, hitAtMs), 'ヒットの時刻を変更');
  }
  /** 難易度間衝突だけを修復する（1回の Undo で戻る） */
  repairConflicts(): cmd.RepairOutcome {
    const r = cmd.repairCrossLevelConflicts(this.doc);
    this.commitDoc(r.doc, '難易度間の衝突を修復');
    this.set({ selection: null, readOnly: false });
    return r;
  }
  setReadOnly(readOnly: boolean): void {
    this.set({ readOnly });
  }
  setGenerationWarnings(generationWarnings: string[]): void {
    this.set({ generationWarnings });
  }
  setScrub(scrub: EditorState['scrub']): void {
    this.set({ scrub });
  }
  setPlaytest(playtest: EditorState['playtest']): void {
    this.set({ playtest });
  }
  setLibrary(library: LibraryEntrySummary[]): void {
    this.set({ library });
  }
  deleteSelection(): void {
    const sel = this.state.selection;
    if (!sel) return;
    if (sel.kind === 'notes') this.commitDoc(cmd.deleteNotes(this.doc, sel.level, sel.ids), sel.ids.size > 1 ? '複数ヒットを削除' : 'ヒットを削除');
    else this.commitDoc(cmd.deleteChorus(this.doc, sel.id), 'サビ区間を削除');
    this.set({ selection: null });
  }
  addChorus(startMs: number, endMs: number): string {
    const r = cmd.addChorus(this.doc, startMs, endMs);
    this.commitDoc(r.doc, 'サビ区間を追加');
    this.set({ selection: { kind: 'chorus', id: r.id } });
    return r.id;
  }
  updateChorus(id: string, patch: { startMs?: number; endMs?: number }, label = 'サビ区間を変更'): void {
    this.commitDoc(cmd.updateChorus(this.doc, id, patch), label);
  }
  moveChorus(id: string, deltaMs: number): void {
    this.commitDoc(cmd.moveChorus(this.doc, id, deltaMs), 'サビ区間を移動');
  }
  mergeOverlaps(): void {
    this.commitDoc(cmd.mergeOverlappingChoruses(this.doc), 'サビ区間を結合');
    this.set({ selection: null });
  }
  setLevelSettings(level: LevelKey, patch: Partial<LevelGenerationSettings>): void {
    this.commitDoc(cmd.setLevelSettings(this.doc, level, patch), `LEVEL ${level} の設定を変更`);
  }
  applyAnalysis(analysis: AnalysisResult): string[] {
    const withAnalysis = cmd.applyAnalysis(this.doc, analysis);
    const hasNotes = LEVEL_KEYS.some((k) => withAnalysis.levels[k].notes.length > 0);
    const outcome = hasNotes ? null : cmd.regenerateLevels(withAnalysis, LEVEL_KEYS, 'replace');
    this.commitDoc(outcome ? outcome.doc : withAnalysis, '解析結果を適用');
    if (hasNotes && withAnalysis.noteMode !== 'additive') this.set({ dialog: { kind: 'regenerate', reason: 'analysis' } });
    return outcome?.shortfalls ?? [];
  }
  /** 再生成（LEVEL 1→4 の優先順）。目標数に届かなかったレベルの警告を返す */
  regenerate(levels: readonly LevelKey[], policy: ManualNotePolicy): string[] {
    const outcome = cmd.regenerateLevels(this.doc, levels, policy);
    this.commitDoc(outcome.doc, levels.length === 4 ? '4難易度を再生成' : `LEVEL ${levels.join(',')} を再生成`);
    this.set({ selection: null, readOnly: false });
    return outcome.shortfalls;
  }

  // ---- 選択・表示 ----
  setSelection(selection: Selection): void {
    this.set({ selection });
  }
  selectAllInActiveLevel(): void {
    const level = this.state.view.activeLevel;
    this.set({ selection: { kind: 'notes', level, ids: new Set(this.doc.levels[level].notes.map((n) => n.id)) } });
  }
  setView(patch: Partial<ViewState>): void {
    this.set({ view: { ...this.state.view, ...patch } });
  }
  setLoop(patch: Partial<LoopState>): void {
    this.set({ loop: { ...this.state.loop, ...patch } });
  }
  setPlayback(patch: Partial<PlaybackPrefs>): void {
    this.set({ playback: { ...this.state.playback, ...patch } });
  }
  setAnalysis(patch: Partial<AnalysisJobState>): void {
    this.set({ analysis: { ...this.state.analysis, ...patch } });
  }
  nextJobId(): number {
    const jobId = this.state.analysis.jobId + 1;
    this.set({ analysis: { jobId, status: 'decoding', stage: 'decode', ratio: 0, message: '音声をデコード中' } });
    return jobId;
  }
  setAudioLoaded(loaded: boolean): void {
    this.set({ audioLoaded: loaded, peaksVersion: this.state.peaksVersion + 1 });
  }
  setDialog(dialog: DialogState): void {
    this.set({ dialog });
  }
  setStatus(status: EditorState['status']): void {
    this.set({ status });
  }
  setDragPreview(p: EditorState['dragPreview']): void {
    this.set({ dragPreview: p });
  }
}

export const editorStore = new EditorStore();

export function useEditorState<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(editorStore.subscribe, () => selector(editorStore.getState()), () => selector(editorStore.getState()));
}

export function useDocument(): EditorDocument {
  return useEditorState((s) => present(s.history));
}
