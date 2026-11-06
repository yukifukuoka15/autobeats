import type { AnalysisStage, WaveformPeaks } from '@autobeats/audio-analysis';
import { LEVEL_KEYS, formatTimecode, hasOverlappingChoruses, type LevelKey } from '@autobeats/chart-format';
import type { AudioMeta, AudioOpenResult, MenuAction, ProjectLoadResult, VerifyPackageResult } from '../../shared/types';
import { AnalysisClient, type AnalysisJobHandle } from './analysis/client';
import { api } from './api';
import { DecodeError, fetchAndDecode } from './audio/decode';
import { Transport } from './audio/transport';
import { ScrubController } from './scrub/scrubController';
import { buildSnapGrid } from './timeline/snap';
import { editorStore, runtime, type PlaybackPrefs } from './store/editorStore';
import { setPlayhead } from './store/playhead';
import { checkPlacement, createEmptyDocument, findNoteIssues, summarizeIssues } from './store/document';
import type { ManualNotePolicy } from '@autobeats/audio-analysis';

const AUTOSAVE_INTERVAL_MS = 30000;
const AUTOSAVE_DEBOUNCE_MS = 5000;

class Controller {
  readonly transport: Transport;
  /** 停止中の矢印キースクラブ */
  readonly scrub: ScrubController;
  private client = new AnalysisClient();
  private job: AnalysisJobHandle | null = null;
  private autosaveTimer: number | null = null;
  private autosaveDebounce: number | null = null;
  private lastHistoryIndex = -1;
  private playheadRaf = 0;

  constructor() {
    this.transport = new Transport({
      getBeats: () => editorStore.doc.analysis?.beats ?? [],
      getDownbeats: () => editorStore.doc.analysis?.downbeats ?? [],
      getPreviewNotes: () => {
        const s = editorStore.getState();
        return editorStore.doc.levels[s.view.activeLevel].notes.map((n) => n.hitAtMs);
      },
    });
    this.transport.setOnEnded(() => this.pumpPlayhead());
    this.scrub = new ScrubController({
      isPlaying: () => this.transport.playing,
      hasAudio: () => this.transport.hasBuffer,
      durationMs: () => this.transport.durationMs,
      currentMs: () => Math.round(this.transport.currentMs()),
      seek: (ms) => this.seek(ms),
      playGrain: (ms, direction, lengthMs) => this.transport.playScrubGrain(ms, direction, lengthMs),
      stopGrains: () => this.transport.stopScrubGrains(),
    });
    this.scrub.subscribe((st) => editorStore.setScrub({ active: st.active, holding: st.holding, direction: st.direction, timeMs: st.timeMs }));
    this.applyPlaybackPrefs(editorStore.getState().playback);
    editorStore.subscribe(() => this.onStoreChange());
    this.startPlayheadPump();
    this.autosaveTimer = window.setInterval(() => void this.autosave(), AUTOSAVE_INTERVAL_MS);
    void this.refreshLibrary();
  }

  // ---- 楽曲ライブラリ ----
  async refreshLibrary(): Promise<void> {
    try {
      editorStore.setLibrary(await api.libraryList());
    } catch {
      // 一覧取得失敗は致命的ではない
    }
  }
  async openLibraryEntry(id: string): Promise<void> {
    if (!(await this.checkUnsaved())) return;
    await this.applyLoadResult(await api.libraryOpen(id), false);
    await this.refreshLibrary();
  }
  async removeLibraryEntry(id: string): Promise<void> {
    const r = await api.libraryRemove(id);
    if (r.ok) editorStore.setStatus({ kind: 'info', text: 'ライブラリから削除しました（元の音声ファイルは残っています）' });
    else if (r.message) editorStore.setStatus({ kind: 'warn', text: r.message });
    await this.refreshLibrary();
  }

  // ---- 時計 ----
  currentMs(): number {
    return this.transport.currentMs();
  }
  isPlaying(): boolean {
    return this.transport.playing;
  }
  private startPlayheadPump(): void {
    const loop = () => {
      this.pumpPlayhead();
      this.playheadRaf = requestAnimationFrame(loop);
    };
    this.playheadRaf = requestAnimationFrame(loop);
  }
  private pumpPlayhead(): void {
    setPlayhead(Math.round(this.transport.currentMs()), this.transport.playing);
  }

  // ---- 再生 ----
  async togglePlay(): Promise<void> {
    this.scrub.cancel();
    this.cancelMash();
    if (this.transport.playing) this.transport.pause();
    else await this.transport.play();
    this.pumpPlayhead();
  }
  async play(): Promise<void> {
    this.scrub.cancel();
    await this.transport.play();
    this.pumpPlayhead();
  }
  pause(): void {
    this.transport.pause();
    this.pumpPlayhead();
  }
  stop(): void {
    this.transport.stop();
    this.pumpPlayhead();
  }
  seek(ms: number): void {
    this.transport.seek(Math.round(ms));
    this.pumpPlayhead();
  }
  seekToStart(): void {
    this.seek(0);
  }
  seekToEnd(): void {
    this.seek(this.transport.durationMs);
  }
  nudgePlayhead(deltaMs: number): void {
    this.seek(this.currentMs() + deltaMs);
  }
  setRate(rate: PlaybackPrefs['rate']): void {
    editorStore.setPlayback({ rate });
  }
  toggleLoop(): void {
    const s = editorStore.getState();
    const dur = editorStore.doc.audio?.durationMs ?? 0;
    const loop = s.loop.endMs > s.loop.startMs ? s.loop : { enabled: false, startMs: 0, endMs: Math.min(dur, 8000) };
    editorStore.setLoop({ ...loop, enabled: !s.loop.enabled });
    this.syncLoop();
  }
  setLoopRange(startMs: number, endMs: number): void {
    editorStore.setLoop({ startMs: Math.round(Math.min(startMs, endMs)), endMs: Math.round(Math.max(startMs, endMs)) });
    this.syncLoop();
  }
  syncLoop(): void {
    this.transport.setLoop(editorStore.getState().loop);
  }
  toggleMetronome(): void {
    editorStore.setPlayback({ metronome: !editorStore.getState().playback.metronome });
  }
  togglePreview(): void {
    editorStore.setPlayback({ preview: !editorStore.getState().playback.preview });
  }
  private applyPlaybackPrefs(p: PlaybackPrefs): void {
    this.transport.setRate(p.rate);
    this.transport.setMetronome(p.metronome);
    this.transport.setPreview(p.preview);
    this.transport.setVolumes(p.volumeSong, p.volumeMetronome, p.volumePreview);
  }

  private lastPrefs: PlaybackPrefs | null = null;
  private lastLoop: unknown = null;
  private onStoreChange(): void {
    const s = editorStore.getState();
    if (s.playback !== this.lastPrefs) {
      this.lastPrefs = s.playback;
      this.applyPlaybackPrefs(s.playback);
    }
    if (s.loop !== this.lastLoop) {
      this.lastLoop = s.loop;
      this.transport.setLoop(s.loop);
    }
    if (s.history.index !== this.lastHistoryIndex) {
      this.lastHistoryIndex = s.history.index;
      void api.setDirty(editorStore.dirty);
      if (editorStore.dirty) this.scheduleAutosave();
    }
  }

  // ---- 音声読み込み ----
  async openAudio(): Promise<void> {
    if (!(await this.confirmReplaceAudio())) return;
    const r = await api.openAudioDialog();
    await this.handleAudioOpen(r);
  }

  async importYoutube(text: string): Promise<void> {
    if (!(await this.confirmReplaceAudio())) return;
    editorStore.setStatus({ kind: 'info', text: 'YouTube から音声を取得・変換中…' });
    try {
      await this.handleAudioOpen(await api.importYoutube(text));
    } catch (error) {
      editorStore.setDialog({ kind: 'message', title: 'YouTube の取り込みに失敗しました', lines: [String(error)] });
    }
  }

  private async confirmReplaceAudio(): Promise<boolean> {
    const doc = editorStore.doc;
    if (!doc.audio) return true;
    const hasNotes = LEVEL_KEYS.some((k) => doc.levels[k].notes.length > 0);
    if (!hasNotes) return true;
    return window.confirm('別の楽曲を読み込むと、現在の譜面（ヒット・サビ区間・解析結果）は破棄されます。続行しますか？');
  }

  async handleAudioOpen(r: AudioOpenResult): Promise<boolean> {
    if (!r) return false;
    if (!r.ok) {
      editorStore.setDialog({ kind: 'message', title: '楽曲を読み込めません', lines: [r.message] });
      return false;
    }
    const meta: Omit<AudioMeta, 'durationMs' | 'sampleRate' | 'channels'> = r;
    return this.loadAudio(meta);
  }

  /** トークンから音声をデコードしてランタイムとドキュメントへ反映する */
  async loadAudio(meta: Omit<AudioMeta, 'durationMs' | 'sampleRate' | 'channels'>, keepDocument = false): Promise<boolean> {
    this.cancelAnalysis();
    this.scrub.cancel();
    this.transport.stop();
    const jobId = editorStore.nextJobId();
    editorStore.setStatus({ kind: 'info', text: `${meta.fileName} をデコード中…` });
    let buffer: AudioBuffer;
    try {
      buffer = await fetchAndDecode(api.mediaUrl(meta.token), this.transport.ctx);
    } catch (err) {
      editorStore.setAnalysis({ status: 'error', message: (err as Error).message });
      editorStore.setStatus({ kind: 'error', text: (err as Error).message });
      editorStore.setDialog({ kind: 'message', title: '楽曲を読み込めません', lines: [err instanceof DecodeError ? err.message : String(err)] });
      return false;
    }
    if (editorStore.getState().analysis.jobId !== jobId) return false;
    runtime.audioBuffer = buffer;
    runtime.peaks = null;
    this.transport.setBuffer(buffer);
    const full: AudioMeta = { ...meta, durationMs: Math.round(buffer.duration * 1000), sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels };
    if (!keepDocument) editorStore.setAudio(full);
    editorStore.setAudioLoaded(true);
    editorStore.setStatus({ kind: 'info', text: `${meta.fileName} を読み込みました（${full.channels}ch / ${full.sampleRate}Hz）。音声はアプリ内のライブラリへ保存しました。` });
    void this.refreshLibrary();
    // 波形ピークだけを先に作る
    editorStore.setAnalysis({ status: 'running', stage: 'peaks', ratio: 0, message: '波形ピークを生成' });
    this.job = this.client.start(jobId, buffer, { onProgress: () => undefined, onPeaks: (p) => this.onPeaks(jobId, p) }, true);
    try {
      await this.job.done;
    } catch (err) {
      editorStore.setStatus({ kind: 'error', text: `波形生成に失敗しました: ${(err as Error).message}` });
    }
    if (editorStore.getState().analysis.jobId === jobId) editorStore.setAnalysis({ status: 'idle', ratio: 0, message: '' });
    this.pumpPlayhead();
    return true;
  }

  private onPeaks(jobId: number, peaks: WaveformPeaks): void {
    if (editorStore.getState().analysis.jobId !== jobId) return;
    runtime.peaks = peaks;
    editorStore.setAudioLoaded(true);
  }

  // ---- 解析 ----
  async analyze(): Promise<void> {
    const buffer = runtime.audioBuffer;
    if (!buffer) {
      editorStore.setStatus({ kind: 'warn', text: '先に楽曲を読み込んでください' });
      return;
    }
    this.cancelAnalysis();
    const jobId = editorStore.nextJobId();
    editorStore.setAnalysis({ status: 'running', stage: 'prepare', ratio: 0, message: '解析を開始' });
    this.job = this.client.start(jobId, buffer, {
      onProgress: (stage, ratio, message) => {
        if (editorStore.getState().analysis.jobId !== jobId) return;
        editorStore.setAnalysis({ status: 'running', stage: stage as AnalysisStage, ratio, message });
      },
      onPeaks: (p) => this.onPeaks(jobId, p),
    });
    try {
      const result = await this.job.done;
      if (!result) {
        if (editorStore.getState().analysis.jobId === jobId) editorStore.setAnalysis({ status: 'cancelled', message: 'キャンセルしました' });
        return;
      }
      if (editorStore.getState().analysis.jobId !== jobId) return; // 古いジョブ
      const shortfalls = editorStore.applyAnalysis(result);
      this.reportShortfalls(shortfalls);
      editorStore.setAnalysis({ status: 'done', ratio: 1, message: `完了: BPM ${result.bpm.toFixed(1)} / 拍 ${result.beats.length} / オンセット ${result.onsets.length} / サビ候補 ${result.choruses.length}` });
      editorStore.setStatus({ kind: 'info', text: `解析完了（BPM ${result.bpm.toFixed(1)}、サビ候補 ${result.choruses.length} 件）。精度は音源により変わるため、必ず試聴して手修正してください。` });
    } catch (err) {
      if (editorStore.getState().analysis.jobId === jobId) {
        editorStore.setAnalysis({ status: 'error', message: (err as Error).message });
        editorStore.setDialog({ kind: 'message', title: '解析に失敗しました', lines: [(err as Error).message] });
      }
    }
  }

  cancelAnalysis(): void {
    if (this.job) {
      this.job.cancel();
      this.job = null;
      const s = editorStore.getState().analysis;
      if (s.status === 'running' || s.status === 'decoding') editorStore.setAnalysis({ status: 'cancelled', message: 'キャンセルしました' });
    }
  }

  /** プレイテスト画面を開く（Q/W/O/P で 4 レーン同時試奏） */
  openPlaytest(): void {
    if (!editorStore.doc.audio) {
      editorStore.setStatus({ kind: 'warn', text: '先に楽曲を読み込んでください' });
      return;
    }
    this.scrub.cancel();
    this.pause();
    editorStore.setDialog({ kind: 'none' });
    editorStore.setPlaytest({ open: true });
  }

  // ---- 編集補助 ----
  /**
   * ヒットを追加する。指定位置が他レベルのヒットと衝突（80ms 以内）する場合は、
   * スナップ前の位置 → 近くのスナップ候補（±1 拍）の順に、衝突しない最寄りの位置へ追加して理由を表示する。
   * どこにも置けなければ追加せず理由を表示する。
   */
  addNoteAt(level: LevelKey, ms: number, alt: { rawMs?: number; grid?: readonly number[] } = {}): string | null {
    const doc = editorStore.doc;
    if (!doc.audio) return null;
    const target = Math.round(ms);
    const first = checkPlacement(doc, level, [{ hitAtMs: target }]);
    if (first.ok) return this.commitAdd(level, target, null);
    const beatMs = doc.bpm > 0 ? 60000 / doc.bpm : 500;
    const grid = alt.grid ?? buildSnapGrid(doc.analysis, editorStore.getState().view.snapTarget, doc.bpm, doc.offsetMs, doc.audio.durationMs);
    const candidates: number[] = [];
    if (alt.rawMs !== undefined && Math.round(alt.rawMs) !== target) candidates.push(Math.round(alt.rawMs));
    candidates.push(...grid.filter((g) => g !== target && Math.abs(g - target) <= beatMs).sort((a, b) => Math.abs(a - target) - Math.abs(b - target)));
    // 自動で位置をずらす場合は、同一レベルの最小間隔も満たす位置だけを採用する
    for (const c of candidates) {
      if (checkPlacement(doc, level, [{ hitAtMs: c }], { rejectMinGap: true }).ok) return this.commitAdd(level, c, `衝突のため最寄りの空き位置（${formatTimecode(c)}）へ追加しました。${first.message.replace(/\n/g, ' ')}`);
    }
    editorStore.setStatus({ kind: 'error', text: `追加できませんでした。${first.message.replace(/\n/g, ' ')} 近くに空き位置もありません。` });
    return null;
  }
  private commitAdd(level: LevelKey, ms: number, note: string | null): string | null {
    const id = editorStore.addNote(level, ms);
    if (!id) return null;
    if (note) editorStore.setStatus({ kind: 'warn', text: note });
    if (editorStore.getState().playback.preview) this.transport.tickNow();
    return id;
  }

  /**
   * ドラッグ終了時の確定。衝突する位置なら、単一ヒットは最寄りの衝突しないスナップ候補へ移動し、
   * 候補がなければ（または複数選択なら）元の位置へ戻す。どちらを採用したかを表示する。
   */
  dropNotes(level: LevelKey, ids: ReadonlySet<string>, deltaMs: number, grid: readonly number[]): void {
    const doc = editorStore.doc;
    const targets = doc.levels[level].notes.filter((n) => ids.has(n.id));
    if (targets.length === 0) return;
    const check = checkPlacement(doc, level, targets.map((n) => ({ id: n.id, hitAtMs: Math.round(n.hitAtMs + deltaMs) })), { rejectMinGap: targets.length > 1 });
    if (check.ok) {
      editorStore.setSelection({ kind: 'notes', level, ids });
      editorStore.moveSelectedNotes(deltaMs);
      return;
    }
    if (targets.length === 1) {
      const note = targets[0]!;
      const wanted = Math.round(note.hitAtMs + deltaMs);
      const beatMs = doc.bpm > 0 ? 60000 / doc.bpm : 500;
      const candidates = grid.filter((g) => Math.abs(g - wanted) <= beatMs && g !== note.hitAtMs).sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));
      for (const g of candidates) {
        if (checkPlacement(doc, level, [{ id: note.id, hitAtMs: g }]).ok) {
          editorStore.setSelection({ kind: 'notes', level, ids });
          if (editorStore.setNoteTime(level, note.id, g)) {
            editorStore.setStatus({ kind: 'warn', text: `衝突のため最寄りのスナップ候補（${formatTimecode(g)}）へ移動しました。${check.message.replace(/\n/g, ' ')}` });
          }
          return;
        }
      }
    }
    editorStore.setStatus({ kind: 'error', text: `衝突のため元の位置へ戻しました。${check.message.replace(/\n/g, ' ')}` });
  }

  /** 再生成を実行し、目標数に届かなかったレベルを警告する */
  regenerate(levels: readonly LevelKey[], policy: ManualNotePolicy): void {
    const shortfalls = editorStore.regenerate(levels, policy);
    this.reportShortfalls(shortfalls);
  }

  /** 目標数に届かなかったレベルの警告を状態バーと検証パネルへ出す（モーダルにはしない） */
  private reportShortfalls(shortfalls: string[]): void {
    editorStore.setGenerationWarnings(shortfalls);
    if (shortfalls.length === 0) return;
    editorStore.setStatus({ kind: 'warn', text: shortfalls.map((t) => t.replace(/\n/g, ' ')).join(' / ') });
  }

  /** 難易度間衝突だけを修復し、結果を表示する */
  repairConflicts(): void {
    const r = editorStore.repairConflicts();
    editorStore.setDialog({
      kind: 'message',
      title: '難易度間の衝突を修復しました',
      lines: [`移動: ${r.moved} ヒット`, `削除: ${r.deleted} ヒット`, `未修復: ${r.unresolved} 件`, '修復は 1 回の Undo で戻せます。'],
    });
  }

  /** 異なる難易度の重なりは許可し、読み込み時に変更しない。 */
  checkConflictsAfterLoad(_source: string): boolean {
    return false;
  }

  /** 書き出し前の全件検証（難易度間衝突・同一レベル重複・最小間隔・範囲外・ID・非整数） */
  private exportBlockingErrors(): string[] {
    const issues = findNoteIssues(editorStore.doc);
    const summary = summarizeIssues(issues);
    if (!summary.hasErrors) return [];
    const lines: string[] = [];
    if (summary.byCode['cross-level'] > 0) {
      lines.push(`難易度間の衝突: ${summary.byCode['cross-level']}件`);
      for (const [pair, n] of Object.entries(summary.crossLevelByPair)) if (n > 0) lines.push(`L${pair.replace('-', '–L')}: ${n}件`);
    }
    if (summary.byCode.collision > 0) lines.push(`同一レベル内の同一時刻: ${summary.byCode.collision}件`);
    if (summary.byCode['min-gap'] > 0) lines.push(`同一レベル内の最小間隔違反: ${summary.byCode['min-gap']}件`);
    if (summary.byCode.range > 0) lines.push(`曲の範囲外: ${summary.byCode.range}件`);
    if (summary.byCode['bad-id'] > 0) lines.push(`不正なID: ${summary.byCode['bad-id']}件`);
    if (summary.byCode['non-integer'] > 0) lines.push(`非整数の hitAtMs: ${summary.byCode['non-integer']}件`);
    lines.push('--- 全件 ---');
    for (const i of issues) lines.push(`・${i.message}`);
    return lines;
  }
  /** 再生ヘッド位置・編集中レベルへヒットを追加する（J / N / Enter）。再生中のタップ入力にも使える */
  addNoteAtPlayhead(): void {
    this.addNoteAt(editorStore.getState().view.activeLevel, Math.round(this.currentMs()));
  }

  // ---- 連打（F を押している間） ----
  private mashStart: { level: LevelKey; startMs: number } | null = null;
  /** F を押した: 再生ヘッド位置を連打の開始として記録し、プレビューを表示する */
  beginMash(): void {
    if (!editorStore.doc.audio || this.mashStart) return;
    const level = editorStore.getState().view.activeLevel;
    const startMs = Math.round(this.currentMs());
    this.mashStart = { level, startMs };
    editorStore.setMashPreview({ level, startMs });
  }
  /** F を離した: 開始から現在の再生ヘッドまでを連打として追加する */
  endMash(): void {
    const start = this.mashStart;
    this.mashStart = null;
    editorStore.setMashPreview(null);
    if (!start) return;
    const endMs = Math.round(this.currentMs());
    editorStore.addMash(start.level, start.startMs, endMs);
  }
  /** フォーカス喪失などで途中終了（追加しない） */
  cancelMash(): void {
    this.mashStart = null;
    editorStore.setMashPreview(null);
  }
  get mashActive(): boolean {
    return this.mashStart !== null;
  }
  afterChorusEdit(): void {
    if (hasOverlappingChoruses(editorStore.doc.choruses)) {
      editorStore.setDialog({ kind: 'overlap' });
      return;
    }
    if (editorStore.doc.analysis) editorStore.setDialog({ kind: 'regenerate', reason: 'chorus' });
  }

  // ---- プロジェクト ----
  private async checkUnsaved(): Promise<boolean> {
    if (!editorStore.dirty) return true;
    const choice = await api.confirmUnsaved('未保存の変更があります。');
    if (choice === 'cancel') return false;
    if (choice === 'save') return this.save(false);
    return true;
  }

  async newProject(): Promise<void> {
    if (!(await this.checkUnsaved())) return;
    this.cancelAnalysis();
    this.scrub.cancel();
    this.transport.setBuffer(null);
    runtime.audioBuffer = null;
    runtime.peaks = null;
    await api.projectNew();
    await api.autosaveClearCurrent();
    editorStore.replaceDocument(createEmptyDocument(), { projectName: null });
    editorStore.setAudioLoaded(false);
    editorStore.setStatus({ kind: 'info', text: '新規プロジェクト' });
    this.pumpPlayhead();
  }

  async openProject(): Promise<void> {
    if (!(await this.checkUnsaved())) return;
    const r = await api.projectOpenDialog();
    await this.applyLoadResult(r, false);
  }

  async openRecent(id: string): Promise<void> {
    if (!(await this.checkUnsaved())) return;
    await this.applyLoadResult(await api.recentOpen(id), false);
  }

  async openRecentFromMenu(id: string): Promise<void> {
    if (!(await this.checkUnsaved())) return;
    await this.applyLoadResult(await api.menuOpenRecent(id), false);
  }

  async applyLoadResult(r: ProjectLoadResult, recovered: boolean): Promise<void> {
    if (!r) return;
    if (!r.ok) {
      editorStore.setDialog({ kind: 'message', title: 'プロジェクトを開けません', lines: [r.message] });
      return;
    }
    this.cancelAnalysis();
    this.scrub.cancel();
    this.transport.setBuffer(null);
    runtime.audioBuffer = null;
    runtime.peaks = null;
    editorStore.replaceDocument(r.document, { projectName: r.projectName, view: r.view, dirty: recovered });
    editorStore.setAudioLoaded(false);
    this.pumpPlayhead();
    if (r.document.audio && r.audioStatus === 'ok') {
      await this.loadAudio(r.document.audio, true);
    } else if (r.document.audio) {
      editorStore.setDialog({ kind: 'message', title: '音声ファイルを確認してください', lines: [r.audioMessage ?? '', '左パネルの「音声を指定し直す」から元の音声ファイルを選択できます。'] });
    }
    editorStore.setStatus({ kind: 'info', text: `${r.projectName} を開きました` });
    if (editorStore.getState().dialog.kind === 'none') this.checkConflictsAfterLoad(r.projectName);
  }

  async relocateAudio(): Promise<void> {
    const r = await api.relocateAudioDialog();
    if (!r) return;
    if (!r.ok) {
      editorStore.setDialog({ kind: 'message', title: '音声を読み込めません', lines: [r.message] });
      return;
    }
    const current = editorStore.doc.audio;
    if (current && current.sha256 !== r.sha256) {
      if (!window.confirm('選択したファイルはプロジェクト保存時の音声と内容が異なります（SHA-256 不一致）。この音声で続行すると譜面の時刻が合わない可能性があります。続行しますか？')) return;
    }
    const ok = await this.loadAudio(r, true);
    if (ok) {
      const buffer = runtime.audioBuffer!;
      editorStore.commitDoc({ ...editorStore.doc, audio: { ...r, durationMs: Math.round(buffer.duration * 1000), sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels } }, '音声を指定し直し');
    }
  }

  async save(saveAs: boolean): Promise<boolean> {
    const doc = editorStore.doc;
    if (hasOverlappingChoruses(doc.choruses)) {
      editorStore.setDialog({ kind: 'overlap' });
      return false;
    }
    const r = await api.projectSave(doc, editorStore.getState().view, { saveAs });
    if (r.cancelled) return false;
    if (!r.ok) {
      editorStore.setDialog({ kind: 'message', title: '保存できません', lines: [r.message ?? ''] });
      return false;
    }
    editorStore.markSaved(r.projectName ?? null);
    await api.setDirty(false);
    await api.autosaveClearCurrent();
    editorStore.setStatus({ kind: 'info', text: `保存しました: ${r.projectName}` });
    void this.refreshLibrary();
    return true;
  }

  private scheduleAutosave(): void {
    if (this.autosaveDebounce !== null) window.clearTimeout(this.autosaveDebounce);
    this.autosaveDebounce = window.setTimeout(() => void this.autosave(), AUTOSAVE_DEBOUNCE_MS);
  }

  async autosave(): Promise<void> {
    if (!editorStore.dirty) return;
    const doc = editorStore.doc;
    if (!doc.audio && LEVEL_KEYS.every((k) => doc.levels[k].notes.length === 0)) return;
    try {
      await api.autosaveWrite(doc, editorStore.getState().view);
      editorStore.setStatus({ kind: 'info', text: `自動保存しました（${new Date().toLocaleTimeString('ja-JP')}）` });
      void this.refreshLibrary();
    } catch (err) {
      editorStore.setStatus({ kind: 'warn', text: `自動保存に失敗: ${(err as Error).message}` });
    }
  }

  async checkRecovery(): Promise<void> {
    const entries = await api.recoveryList();
    if (entries.length > 0) editorStore.setDialog({ kind: 'recovery', entries });
  }

  async recover(id: string): Promise<void> {
    editorStore.setDialog({ kind: 'none' });
    await this.applyLoadResult(await api.recoveryOpen(id), true);
  }

  async discardRecovery(id: string): Promise<void> {
    await api.recoveryDiscard(id);
    await this.checkRecovery();
    if (editorStore.getState().dialog.kind === 'recovery' && (await api.recoveryList()).length === 0) editorStore.setDialog({ kind: 'none' });
  }

  // ---- 書き出し ----
  async exportPackage(opts: { requestId?: string; mode?: 'ask' | 'overwrite' | 'rename' } = {}): Promise<void> {
    const doc = editorStore.doc;
    if (!doc.audio) {
      editorStore.setDialog({ kind: 'message', title: '書き出せません', lines: ['楽曲が読み込まれていません。'] });
      return;
    }
    if (hasOverlappingChoruses(doc.choruses)) {
      editorStore.setDialog({ kind: 'overlap' });
      return;
    }
    const blocking = this.exportBlockingErrors();
    if (blocking.length > 0) {
      editorStore.setDialog({ kind: 'export-result', ok: false, title: '書き出しできません（検証エラー）', lines: blocking });
      return;
    }
    const r = await api.exportPackage(doc, opts);
    if (r.status === 'cancelled') return;
    if (r.status === 'exists') {
      editorStore.setDialog({ kind: 'export-exists', requestId: r.requestId, displayPath: r.displayPath });
      return;
    }
    if (r.status === 'error') {
      editorStore.setDialog({ kind: 'export-result', ok: false, title: '書き出しに失敗しました', lines: r.errors.map((e) => `・${e.message}`) });
      return;
    }
    editorStore.setDialog({
      kind: 'export-result',
      ok: true,
      title: '書き出しと再検証が完了しました',
      lines: [`フォルダ: ${r.displayPath}`, 'chart.json と音声のハッシュ・スキーマ・全時刻・全レベルを再検証しました。', ...(r.warnings.length > 0 ? ['警告:', ...r.warnings.map((w) => `・${w.message}`)] : [])],
    });
    editorStore.setStatus({ kind: 'info', text: `書き出し完了: ${r.displayPath}` });
  }

  async exportChartJson(): Promise<void> {
    const blocking = this.exportBlockingErrors();
    if (blocking.length > 0) {
      editorStore.setDialog({ kind: 'export-result', ok: false, title: '譜面JSONを書き出せません（検証エラー）', lines: blocking });
      return;
    }
    const r = await api.exportChartJson(editorStore.doc);
    if (r.status === 'cancelled') return;
    if (r.status === 'error') editorStore.setDialog({ kind: 'export-result', ok: false, title: '譜面JSONを書き出せません', lines: r.errors.map((e) => `・${e.message}`) });
    else editorStore.setDialog({ kind: 'export-result', ok: true, title: '譜面JSONを書き出しました', lines: [r.displayPath, ...r.warnings.map((w) => `・${w.message}`)] });
  }

  async verifyPackage(): Promise<void> {
    const r = await api.verifyPackageDialog(editorStore.doc.audio ? editorStore.doc : null);
    if (!r) return;
    const lines = r.ok
      ? [
          '検証に成功しました。',
          `楽曲ID: ${r.chart?.trackId}  曲名: ${r.chart?.title}  BPM: ${r.chart?.bpm}`,
          ...LEVEL_KEYS.map((k) => `LEVEL ${k}: ${r.chart?.levels[k].notes.length ?? 0} 音`),
          ...r.warnings.map((w) => `警告: ${w.message}`),
        ]
      : r.errors.map((e) => `・${e.message}`);
    const canImport = r.ok && !!editorStore.doc.audio && r.chart?.audioSha256 === editorStore.doc.audio.sha256;
    editorStore.setDialog({ kind: 'verify-result', ok: r.ok, displayPath: r.displayPath ?? '', lines, canImport, chart: r.chart ?? null });
  }

  importVerifiedChart(chart: NonNullable<VerifyPackageResult['chart']>): void {
    const doc = editorStore.doc;
    const levels = { ...doc.levels };
    for (const k of LEVEL_KEYS) levels[k] = { displayName: chart.levels[k].displayName, notes: chart.levels[k].notes.map((n) => ({ ...n })) };
    editorStore.commitDoc({ ...doc, choruses: chart.choruses.map((c) => ({ ...c })), levels, bpm: chart.bpm }, '書き出した譜面を読み込み');
    editorStore.setDialog({ kind: 'none' });
    this.checkConflictsAfterLoad('chart.json');
  }

  /** 問題一覧から該当箇所へ移動する */
  jumpToIssue(level: LevelKey, id: string, hitAtMs: number): void {
    editorStore.setView({ activeLevel: level });
    editorStore.setSelection({ kind: 'notes', level, ids: new Set([id]) });
    this.seek(hitAtMs);
    const s = editorStore.getState();
    const width = document.querySelector('[data-testid="timeline"]')?.clientWidth ?? 1000;
    const scale = s.view.zoomPxPerSec / 1000;
    const x = (hitAtMs - s.view.scrollMs) * scale;
    if (x < 0 || x > width * 0.9) editorStore.setView({ scrollMs: Math.max(0, hitAtMs - (width * 0.3) / scale) });
  }

  // ---- メニュー ----
  async handleMenu(action: MenuAction): Promise<void> {
    switch (action) {
      case 'new':
        return this.newProject();
      case 'open':
        return this.openProject();
      case 'save':
        await this.save(false);
        return;
      case 'saveAs':
        await this.save(true);
        return;
      case 'undo':
        editorStore.undo();
        return;
      case 'redo':
        editorStore.redo();
        return;
      case 'export':
        return this.exportPackage();
      case 'exportJson':
        return this.exportChartJson();
      case 'verifyPackage':
        return this.verifyPackage();
      case 'analyze':
        return this.analyze();
      case 'selectAll':
        editorStore.selectAllInActiveLevel();
        return;
      case 'zoomIn':
      case 'zoomOut':
        this.zoom(action === 'zoomIn' ? 1.25 : 1 / 1.25);
        return;
    }
  }

  zoom(factor: number): void {
    const s = editorStore.getState();
    const dur = editorStore.doc.audio?.durationMs ?? 0;
    const width = document.querySelector('[data-testid="timeline"]')?.clientWidth ?? 1000;
    const scale = s.view.zoomPxPerSec / 1000;
    const cursorX = Math.max(0, Math.min(width, (this.currentMs() - s.view.scrollMs) * scale));
    const next = Math.min(4000, Math.max(4, s.view.zoomPxPerSec * factor));
    const nextScroll = Math.max(0, this.currentMs() - cursorX / (next / 1000));
    editorStore.setView({ zoomPxPerSec: next, scrollMs: Math.min(Math.max(0, dur), nextScroll) });
  }
}

export const controller = new Controller();
