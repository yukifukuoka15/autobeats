import { JUDGE } from './constants';
import type { EarlyLate, Judgement } from './types';

export type HitJudgement = Exclude<Judgement, 'MISS'>;

/** 補正後押下時刻 = Mac受信時刻 - 入力遅延補正値 */
export function applyInputOffset(receivedAtMs: number, inputOffsetMs: number): number {
  return receivedAtMs - inputOffsetMs;
}

export function clampInputOffset(value: number): number {
  const { minMs, maxMs, stepMs } = JUDGE.inputOffset;
  if (!Number.isFinite(value)) return 0;
  const snapped = Math.round(value / stepMs) * stepMs;
  return Math.min(maxMs, Math.max(minMs, snapped));
}

/** 時間差（補正後押下時刻 - 正解時刻）から判定を返す。範囲外は null。 */
export function classifyDelta(deltaMs: number): HitJudgement | null {
  const d = Math.abs(deltaMs);
  if (d <= JUDGE.perfectMs) return 'PERFECT';
  if (d <= JUDGE.goodMs) return 'GOOD';
  if (d <= JUDGE.badMs) return 'BAD';
  return null;
}

export function scoreFor(j: Judgement): number {
  return JUDGE.score[j];
}

export function breaksCombo(j: Judgement | 'EMPTY'): boolean {
  return j === 'BAD' || j === 'MISS' || j === 'EMPTY';
}

/** PERFECT では EARLY/LATE を表示しない */
export function earlyLateFor(j: Judgement, deltaMs: number): EarlyLate {
  if (j === 'PERFECT' || j === 'MISS') return null;
  if (deltaMs < 0) return 'EARLY';
  if (deltaMs > 0) return 'LATE';
  return null;
}

export interface JudgeCandidate {
  hitAtMs: number;
  judged: boolean;
}

/**
 * 未判定音符のうち、補正後押下時刻との差が badMs 以内で最も近い1音のインデックスを返す。
 * 同距離なら hitAtMs が早いものを優先する。候補がなければ -1。
 * notes は hitAtMs 昇順を前提とする。
 */
export function findJudgeTarget(notes: readonly JudgeCandidate[], pressedAtMs: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!;
    if (n.judged) continue;
    const dist = Math.abs(n.hitAtMs - pressedAtMs);
    if (n.hitAtMs - pressedAtMs > JUDGE.badMs) break;
    if (dist > JUDGE.badMs) continue;
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
    // 同距離の場合は昇順走査で先に見つかった（早い）音符を維持する
  }
  return best;
}

/** 音符が MISS 確定になる楽曲時刻 */
export function missDeadlineMs(hitAtMs: number): number {
  return hitAtMs + JUDGE.badMs;
}
