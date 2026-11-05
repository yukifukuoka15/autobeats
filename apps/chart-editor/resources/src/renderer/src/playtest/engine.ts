import { JUDGE, LEVEL_KEYS, applyInputOffset, breaksCombo, classifyDelta, earlyLateFor, findJudgeTarget, missDeadlineMs, scoreFor, type ChartNote, type EarlyLate, type Judgement, type LevelKey } from '@autobeats/chart-format';

/** 試奏の実物ボタン相当: LEVEL 1 = Q、2 = W、3 = O、4 = P */
export const PLAYTEST_KEYS: Readonly<Record<LevelKey, string>> = { '1': 'q', '2': 'w', '3': 'o', '4': 'p' };
export const PLAYTEST_COUNTDOWN_MS = JUDGE.countdownMs;
/** 最後の音符の判定猶予後に少し待ってから終了 */
export const PLAYTEST_FINISH_GRACE_MS = 600;

export type PlaytestKind = Judgement | 'EMPTY';

export interface PlaytestNote {
  id: string;
  hitAtMs: number;
  judgement: Judgement | null;
  judgedAtMs: number | null;
  deltaMs: number | null;
}

export interface LaneResult {
  seq: number;
  kind: PlaytestKind;
  earlyLate: EarlyLate;
  atMs: number;
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
  /** 楽曲のこの時刻から開始する（これより前の音符は対象外） */
  startMs: number;
  durationMs: number;
  inputOffsetMs: number;
}

/** 判定ラベル（メインアプリと同じ表記） */
export function playtestResultLabel(kind: PlaytestKind, earlyLate: EarlyLate): string {
  if (kind === 'EMPTY') return '空押し';
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
  /** 終了判定時刻（曲の終わりまたは最後の音符の判定猶予終了 + grace） */
  readonly endAtMs: number;

  constructor(levels: Readonly<Record<LevelKey, { notes: readonly ChartNote[] }>>, options: PlaytestOptions) {
    this.options = options;
    const lanes = {} as Record<LevelKey, LaneState>;
    let lastHit = -Infinity;
    for (const k of LEVEL_KEYS) {
      const notes = [...levels[k].notes]
        .filter((n) => n.hitAtMs >= options.startMs && n.hitAtMs < options.durationMs)
        .sort((a, b) => a.hitAtMs - b.hitAtMs)
        .map((n) => ({ id: n.id, hitAtMs: n.hitAtMs, judgement: null, judgedAtMs: null, deltaMs: null }));
      if (notes.length > 0) lastHit = Math.max(lastHit, notes[notes.length - 1]!.hitAtMs);
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
    const candidates = lane.notes.map((n) => ({ hitAtMs: n.hitAtMs, judged: n.judgement !== null }));
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

  /** 時刻を進め、判定猶予を過ぎた音符を MISS にする */
  tick(songMs: number): void {
    for (const k of LEVEL_KEYS) {
      const lane = this.lanes[k];
      for (const n of lane.notes) {
        if (n.judgement !== null) continue;
        if (songMs > missDeadlineMs(n.hitAtMs)) {
          n.judgement = 'MISS';
          n.judgedAtMs = songMs;
          this.applyJudgement(lane, 'MISS');
          this.setResult(lane, 'MISS', null, songMs);
        } else break; // 昇順なのでここで打ち切れる
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

  private setResult(lane: LaneState, kind: PlaytestKind, earlyLate: EarlyLate, atMs: number): LaneResult {
    const r: LaneResult = { seq: ++this.seq, kind, earlyLate, atMs };
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
