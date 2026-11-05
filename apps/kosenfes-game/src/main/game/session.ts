/**
 * ネオンヒットのゲームセッション（main process の唯一の正本）。
 * Electron に依存せず、時計は注入する。
 *
 * 時計設計:
 * - main は単調増加時計 now() を使う（既定 performance.now()）。
 * - 楽曲時刻 0ms = 音声が実際に鳴り始めた瞬間。renderer は音声開始後に
 *   audioStarted({ latencyMs }) を送り、main は「受信時刻 - latencyMs」を songStart とする。
 *   latencyMs = (ctx.currentTime - 予定開始時刻) * 1000（メッセージ送信時点で音声開始から経過した時間）。
 * - 以後の判定は songTime = now() - songStart だけで決まり、途中でジャンプしない。
 * - renderer からの audioPosition 報告は差の観測にだけ使い、許容値を連続で超えたら異常中断する。
 */
import {
  JUDGE,
  SYNC,
  applyInputOffset,
  breaksCombo,
  classifyDelta,
  earlyLateFor,
  findJudgeTarget,
  missDeadlineMs,
  scoreFor,
  type Judgement,
} from '@autobeats/chart-format';
import type { AbortReason, NoteState, SessionEvent, SessionSnapshot, SessionState } from '../../shared/types';

export const FINISH_GRACE_MS = 300;

export type LedColor = 'white' | 'yellow' | 'orange' | 'purple' | 'dim-red' | 'off';

export interface SessionConfig {
  sessionId: string;
  /** 昇順の hitAtMs */
  notes: number[];
  durationMs: number;
  inputOffsetMs: number;
  /** true なら音声開始ハンドシェイクが必要 */
  requiresAudio: boolean;
  rankingEligible: boolean;
  countdownMs?: number;
}

export interface SessionDeps {
  now?: () => number;
  onEvent?: (e: SessionEvent) => void;
  setLed?: (color: LedColor, durationMs: number) => void;
}

interface NoteRecord {
  hitAtMs: number;
  judged: boolean;
  state: NoteState;
}

const JUDGE_STATE: Record<Judgement, NoteState> = { PERFECT: 1, GOOD: 2, BAD: 3, MISS: 4 };

export class GameSession {
  private readonly now: () => number;
  private readonly onEvent: (e: SessionEvent) => void;
  private readonly setLed: (color: LedColor, durationMs: number) => void;

  private config: SessionConfig | null = null;
  state: SessionState = 'idle';
  abortReason: AbortReason | undefined;
  abortMessage: string | undefined;
  private notes: NoteRecord[] = [];
  private startedAtMs = 0;
  private countdownEndAtMs = 0;
  /** 楽曲時刻 0ms に対応する main 時計の値 */
  private songStartMs: number | null = null;
  private lastPositionReportAtMs = 0;
  private driftViolations = 0;
  private missCursor = 0;
  private endAtSongMs = 0;

  score = 0;
  combo = 0;
  maxCombo = 0;
  emptyPresses = 0;
  counts: Record<Judgement, number> = { PERFECT: 0, GOOD: 0, BAD: 0, MISS: 0 };
  lastJudgement: SessionSnapshot['lastJudgement'] = null;

  private held = false;
  private seenEventIds = new Set<string>();
  private lastSeq = -1;

  constructor(deps: SessionDeps = {}) {
    this.now = deps.now ?? (() => performance.now());
    this.onEvent = deps.onEvent ?? (() => undefined);
    this.setLed = deps.setLed ?? (() => undefined);
  }

  get sessionId(): string | null {
    return this.config?.sessionId ?? null;
  }

  get rankingEligible(): boolean {
    return this.state === 'finished' && (this.config?.rankingEligible ?? false);
  }

  /** カウントダウンを開始する */
  start(config: SessionConfig): void {
    if (this.state !== 'idle' && this.state !== 'ready') throw new Error(`この状態では開始できません: ${this.state}`);
    const sorted = [...config.notes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) throw new Error('同一時刻の音符が含まれています');
    }
    this.config = { ...config, notes: sorted };
    this.notes = sorted.map((hitAtMs) => ({ hitAtMs, judged: false, state: 0 }));
    const last = sorted[sorted.length - 1];
    // 終了規則（唯一の定義）: 曲の長さと最後の音符の判定猶予の遅い方 + 猶予
    this.endAtSongMs = Math.max(config.durationMs, last !== undefined ? last + JUDGE.badMs : 0) + FINISH_GRACE_MS;
    this.startedAtMs = this.now();
    this.countdownEndAtMs = this.startedAtMs + (config.countdownMs ?? JUDGE.countdownMs);
    this.songStartMs = null;
    this.lastPositionReportAtMs = 0;
    this.driftViolations = 0;
    this.missCursor = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.emptyPresses = 0;
    this.counts = { PERFECT: 0, GOOD: 0, BAD: 0, MISS: 0 };
    this.lastJudgement = null;
    this.held = false;
    this.seenEventIds.clear();
    this.lastSeq = -1;
    this.abortReason = undefined;
    this.abortMessage = undefined;
    this.setState('countdown');
    this.setLed('dim-red', 0);
  }

  /** renderer からの音声開始ハンドシェイク。latencyMs = 送信時点で音声開始から経過した時間 */
  audioStarted(input: { sessionId: string; latencyMs: number }): void {
    if (!this.config || input.sessionId !== this.config.sessionId) return;
    if (this.state !== 'countdown') return;
    const received = this.now();
    const latency = Number.isFinite(input.latencyMs) ? Math.max(0, input.latencyMs) : 0;
    const songStart = received - latency;
    const startError = songStart - this.countdownEndAtMs;
    if (Math.abs(startError) > SYNC.maxStartLatencyMs) {
      this.abort('audio-start-failed', `音声の開始が予定より ${Math.round(startError)}ms ずれました（許容 ${SYNC.maxStartLatencyMs}ms）。`);
      return;
    }
    this.songStartMs = songStart;
    this.lastPositionReportAtMs = received;
    this.setState('playing');
  }

  /** renderer からの音声再生失敗通知 */
  audioFailed(sessionId: string, message: string): void {
    if (!this.config || sessionId !== this.config.sessionId) return;
    if (this.state === 'countdown' || this.state === 'playing') this.abort('audio-error', message || '音声の再生に失敗しました。');
  }

  /** 定期的な音声位置の観測（判定時刻は変えない） */
  audioPosition(input: { sessionId: string; songTimeMs: number }): void {
    if (!this.config || input.sessionId !== this.config.sessionId) return;
    if (this.state !== 'playing' || this.songStartMs === null) return;
    const received = this.now();
    this.lastPositionReportAtMs = received;
    const expected = received - this.songStartMs;
    const drift = input.songTimeMs - expected;
    if (Math.abs(drift) > SYNC.maxDriftMs) {
      this.driftViolations++;
      if (this.driftViolations >= SYNC.driftAbortCount) {
        this.abort('audio-desync', `音声と判定時計のずれが ${Math.round(drift)}ms に達しました（許容 ${SYNC.maxDriftMs}ms）。`);
      }
    } else {
      this.driftViolations = 0;
    }
  }

  /** ボタン押下（Mac受信時刻 = main の now() 基準） */
  press(input: { sessionId: string; eventId: string; seq: number; receivedAtMs: number }): void {
    if (!this.config || input.sessionId !== this.config.sessionId) return;
    if (this.seenEventIds.has(input.eventId)) return;
    if (input.seq <= this.lastSeq) return;
    this.seenEventIds.add(input.eventId);
    this.lastSeq = input.seq;
    if (this.held) return; // 押しっぱなし
    this.held = true;
    if (this.state !== 'playing' || this.songStartMs === null) return;
    const pressedAt = applyInputOffset(input.receivedAtMs, this.config.inputOffsetMs);
    const songTime = pressedAt - this.songStartMs;
    this.processMisses(songTime);
    const idx = findJudgeTarget(this.notes, songTime);
    if (idx === -1) {
      this.emptyPresses++;
      this.combo = 0;
      this.lastJudgement = { judgement: 'EMPTY', earlyLate: null, atMs: this.now() };
      this.setLed('purple', JUDGE.led.EMPTY.durationMs);
      this.onEvent({ kind: 'empty-press', sessionId: this.config.sessionId, songTimeMs: Math.round(songTime) });
      return;
    }
    const note = this.notes[idx]!;
    const delta = songTime - note.hitAtMs;
    const judgement = classifyDelta(delta);
    if (judgement === null) return; // findJudgeTarget が範囲内を保証するので到達しない
    note.judged = true;
    note.state = JUDGE_STATE[judgement];
    this.applyJudgement(judgement);
    const earlyLate = earlyLateFor(judgement, delta);
    this.lastJudgement = { judgement, earlyLate, atMs: this.now() };
    const led = JUDGE.led[judgement];
    this.setLed(led.color as LedColor, led.durationMs);
    this.onEvent({ kind: 'judgement', sessionId: this.config.sessionId, noteIndex: idx, judgement, earlyLate, deltaMs: Math.round(delta), songTimeMs: Math.round(songTime) });
  }

  release(input: { sessionId: string; eventId: string; seq: number }): void {
    if (!this.config || input.sessionId !== this.config.sessionId) return;
    if (this.seenEventIds.has(input.eventId)) return;
    if (input.seq <= this.lastSeq) return;
    this.seenEventIds.add(input.eventId);
    this.lastSeq = input.seq;
    this.held = false;
  }

  /** 定期更新。状態遷移・MISS 確定・終了判定を行う */
  tick(): void {
    if (!this.config) return;
    const now = this.now();
    if (this.state === 'countdown') {
      if (!this.config.requiresAudio && now >= this.countdownEndAtMs) {
        this.songStartMs = this.countdownEndAtMs;
        this.lastPositionReportAtMs = now;
        this.setState('playing');
      } else if (this.config.requiresAudio && now >= this.countdownEndAtMs + SYNC.startHandshakeTimeoutMs) {
        this.abort('audio-start-failed', '音声の開始を確認できませんでした。');
        return;
      }
    }
    if (this.state === 'playing' && this.songStartMs !== null) {
      const songTime = now - this.songStartMs;
      if (this.config.requiresAudio && now - this.lastPositionReportAtMs > SYNC.driftReportTimeoutMs) {
        this.abort('audio-desync', '音声再生位置の報告が途絶えました。');
        return;
      }
      this.processMisses(songTime);
      if (songTime >= this.endAtSongMs) {
        this.setState('finished');
        this.setLed('off', 0);
      }
    }
  }

  abort(reason: AbortReason, message?: string): void {
    if (this.state === 'finished' || this.state === 'aborted' || this.state === 'idle') return;
    this.abortReason = reason;
    this.abortMessage = message;
    this.setLed('off', 0);
    this.setState('aborted');
  }

  snapshot(): SessionSnapshot {
    const now = this.now();
    return {
      sessionId: this.config?.sessionId ?? '',
      state: this.state,
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      emptyPresses: this.emptyPresses,
      noteStates: this.notes.map((n) => n.state),
      songTimeMs: this.songStartMs === null ? -(Math.max(0, this.countdownEndAtMs - now)) : Math.round(now - this.songStartMs),
      abortReason: this.abortReason,
      lastJudgement: this.lastJudgement,
    };
  }

  private processMisses(songTime: number): void {
    while (this.missCursor < this.notes.length) {
      const n = this.notes[this.missCursor]!;
      if (n.judged) {
        this.missCursor++;
        continue;
      }
      if (songTime > missDeadlineMs(n.hitAtMs)) {
        n.judged = true;
        n.state = 4;
        this.applyJudgement('MISS');
        this.lastJudgement = { judgement: 'MISS', earlyLate: null, atMs: this.now() };
        this.onEvent({ kind: 'judgement', sessionId: this.config!.sessionId, noteIndex: this.missCursor, judgement: 'MISS', earlyLate: null, deltaMs: JUDGE.badMs + 1, songTimeMs: Math.round(songTime) });
        this.missCursor++;
        continue;
      }
      break;
    }
  }

  private applyJudgement(j: Judgement): void {
    this.counts[j]++;
    this.score += scoreFor(j);
    if (breaksCombo(j)) this.combo = 0;
    else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }
  }

  private setState(state: SessionState): void {
    this.state = state;
    if (this.config) {
      this.onEvent({ kind: 'state', sessionId: this.config.sessionId, state, abortReason: this.abortReason, abortMessage: this.abortMessage });
    }
  }
}
