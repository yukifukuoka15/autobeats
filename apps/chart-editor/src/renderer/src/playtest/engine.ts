import { JUDGE, LEVEL_KEYS, MASH, applyInputOffset, breaksCombo, classifyDelta, earlyLateFor, findJudgeTarget, isInMashSpan, judgeMash, mashRequiredPresses, missDeadlineMs, scoreFor, type ChartNote, type EarlyLate, type Judgement, type LevelKey } from '@autobeats/chart-format';

/** 試奏の実物ボタン相当: LEVEL 1 = Q、2 = W、3 = O、4 = P */
export const PLAYTEST_KEYS: Readonly<Record<LevelKey, string>> = { '1': 'q', '2': 'w', '3': 'o', '4': 'p' };
export const PLAYTEST_COUNTDOWN_MS = JUDGE.countdownMs;
/** 最後のヒットの判定猶予後に少し待ってから終了 */
export const PLAYTEST_FINISH_GRACE_MS = 600;
export { mashRequiredPresses };

export type PlaytestKind = Judgement | 'EMPTY' | 'MASH';

export interface PlaytestNote {
  id: string;
  hitAtMs: number;
  /** 連打の長さ（通常ヒットは 0） */
  durationMs: number;
  judgement: Judgement | null;
  judgedAtMs: number | null;
  deltaMs: number | null;
  /** 連打区間内の押下回数 */
  presses: number;
}

export interface LaneResult {
  seq: number;
  kind: PlaytestKind;
  earlyLate: EarlyLate;
  atMs: number;
  /** 連打中の押下回数（kind === 'MASH'） */
  presses?: number;
}

export interface LaneState {
  level: LevelKey;
  notes: PlaytestNote[];
  /** 押しっぱなし中（解放されるまで次の押下を受け付けない） */
  held: boolean;
  lastResult: LaneResult | null;
  counts: Record<Judgement, number>;
  empty: number;
}

export interface PlaytestOptions {
  /** 楽曲のこの時刻から開始する（これより前のヒットは対象外） */
  startMs: number;
  durationMs: number;
  inputOffsetMs: number;
}

/** 判定ラベル（メインアプリと同じ表記） */
export function playtestResultLabel(kind: PlaytestKind, earlyLate: EarlyLate, presses = 0): string {
  if (kind === 'EMPTY') return '空押し';
  if (kind === 'MASH') return `連打 ×${presses}`;
  if (kind === 'PERFECT' || kind === 'MISS') return kind;
  return earlyLate ? `${kind} ${earlyLate}` : kind;
}

/**
 * エディター内試奏のエンジン（4 レーン同時）。判定は chart-format の共通関数を使い、
 * スコア・コンボは全レーン合算。純粋で時計を持たず、呼び出し側が楽曲時刻を渡す。
 */
export class PlaytestEngine {
  readonly lanes: Record<LevelKey, LaneState>;
  readonly options: PlaytestOptions;
  score = 0;
  combo = 0;
  maxCombo = 0;
  private seq = 0;
  /** 終了判定時刻（曲の終わりまたは最後のヒットの判定猶予終了 + grace） */
  readonly endAtMs: number;

  constructor(levels: Readonly<Record<LevelKey, { notes: readonly ChartNote[] }>>, options: PlaytestOptions) {
    this.options = options;
    const lanes = {} as Record<LevelKey, LaneState>;
    let lastHit = -Infinity;
    for (const k of LEVEL_KEYS) {
      const notes = [...levels[k].notes]
        .filter((n) => n.hitAtMs >= options.startMs && n.hitAtMs < options.durationMs)
        .sort((a, b) => a.hitAtMs - b.hitAtMs)
        .map((n) => ({ id: n.id, hitAtMs: n.hitAtMs, durationMs: n.type === 'mash' ? (n.durationMs ?? 0) : 0, judgement: null, judgedAtMs: null, deltaMs: null, presses: 0 }));
      for (const n of notes) lastHit = Math.max(lastHit, n.hitAtMs + n.durationMs);
      lanes[k] = { level: k, notes, held: false, lastResult: null, counts: { PERFECT: 0, GOOD: 0, BAD: 0, MISS: 0 }, empty: 0 };
    }
    this.lanes = lanes;
    this.endAtMs = Math.max(options.durationMs, Number.isFinite(lastHit) ? lastHit + JUDGE.badMs : 0) + PLAYTEST_FINISH_GRACE_MS;
  }

  get totalNotes(): number {
    return LEVEL_KEYS.reduce((s, k) => s + this.lanes[k].notes.length, 0);
  }

  /** 押下。receivedSongMs は押下を受け取った時点の楽曲時刻 */
  press(level: LevelKey, receivedSongMs: number): LaneResult | null {
    const lane = this.lanes[level];
    if (lane.held) return null;
    lane.held = true;
    const pressedAt = applyInputOffset(receivedSongMs, this.options.inputOffsetMs);
    // 連打区間内の押下は連打として数える（区間終了時に判定を確定）
    const mash = lane.notes.find((n) => n.durationMs > 0 && n.judgement === null && isInMashSpan(pressedAt, n.hitAtMs, n.durationMs));
    if (mash) {
      mash.presses++;
      this.score += MASH.bonusPerPress;
      return this.setResult(lane, 'MASH', null, receivedSongMs, mash.presses);
    }
    // 連打は通常のタイミング判定の対象にしない
    const candidates = lane.notes.map((n) => ({ hitAtMs: n.hitAtMs, judged: n.judgement !== null || n.durationMs > 0 }));
    const idx = findJudgeTarget(candidates, pressedAt);
    if (idx < 0) {
      lane.empty++;
      this.combo = 0;
      return this.setResult(lane, 'EMPTY', null, receivedSongMs);
    }
    const note = lane.notes[idx]!;
    const delta = pressedAt - note.hitAtMs;
    const judgement = classifyDelta(delta);
    if (judgement === null) return null; // findJudgeTarget が範囲内を保証する
    note.judgement = judgement;
    note.judgedAtMs = receivedSongMs;
    note.deltaMs = delta;
    this.applyJudgement(lane, judgement);
    return this.setResult(lane, judgement, earlyLateFor(judgement, delta), receivedSongMs);
  }

  release(level: LevelKey): void {
    this.lanes[level].held = false;
  }

  /** 時刻を進め、判定猶予を過ぎたヒットを MISS にする */
  tick(songMs: number): void {
    for (const k of LEVEL_KEYS) {
      const lane = this.lanes[k];
      for (const n of lane.notes) {
        if (n.judgement !== null) continue;
        if (n.durationMs > 0) {
          // 連打: 区間終了（猶予込み）で押下回数から判定
          if (songMs > n.hitAtMs + n.durationMs + MASH.edgeToleranceMs) {
            const j = judgeMash(n.presses, n.durationMs);
            n.judgement = j;
            n.judgedAtMs = songMs;
            this.applyJudgement(lane, j);
            this.setResult(lane, j, null, songMs, n.presses);
          }
          continue;
        }
        if (songMs > missDeadlineMs(n.hitAtMs)) {
          n.judgement = 'MISS';
          n.judgedAtMs = songMs;
          this.applyJudgement(lane, 'MISS');
          this.setResult(lane, 'MISS', null, songMs);
        }
      }
    }
  }

  isFinished(songMs: number): boolean {
    return songMs >= this.endAtMs;
  }

  private applyJudgement(lane: LaneState, j: Judgement): void {
    lane.counts[j]++;
    this.score += scoreFor(j);
    if (breaksCombo(j)) this.combo = 0;
    else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }
  }

  private setResult(lane: LaneState, kind: PlaytestKind, earlyLate: EarlyLate, atMs: number, presses?: number): LaneResult {
    const r: LaneResult = { seq: ++this.seq, kind, earlyLate, atMs, ...(presses !== undefined ? { presses } : {}) };
    lane.lastResult = r;
    return r;
  }

  /** 合計の判定数 */
  totals(): Record<Judgement, number> & { empty: number } {
    const t = { PERFECT: 0, GOOD: 0, BAD: 0, MISS: 0, empty: 0 };
    for (const k of LEVEL_KEYS) {
      const l = this.lanes[k];
      t.PERFECT += l.counts.PERFECT;
      t.GOOD += l.counts.GOOD;
      t.BAD += l.counts.BAD;
      t.MISS += l.counts.MISS;
      t.empty += l.empty;
    }
    return t;
  }
}
