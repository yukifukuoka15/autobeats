import { MASH } from './constants';
import type { Judgement } from './types';

/** 区間の長さから「満点」に必要な押下回数を求める */
export function mashRequiredPresses(durationMs: number): number {
  return Math.max(1, Math.ceil(durationMs / MASH.requiredPressIntervalMs));
}

/** 押下時刻が連打区間（前後の猶予を含む）に入っているか */
export function isInMashSpan(pressedAtMs: number, startMs: number, durationMs: number): boolean {
  return pressedAtMs >= startMs - MASH.edgeToleranceMs && pressedAtMs <= startMs + durationMs + MASH.edgeToleranceMs;
}

/**
 * 連打の判定（区間終了時に確定）。
 * 必要回数以上 = PERFECT、半分以上 = GOOD、1 回以上 = BAD、0 回 = MISS。
 * 区間内の押下 1 回ごとに MASH.bonusPerPress を加点する（呼び出し側で合算）。
 */
export function judgeMash(presses: number, durationMs: number): Judgement {
  const required = mashRequiredPresses(durationMs);
  if (presses >= required) return 'PERFECT';
  if (presses * 2 >= required) return 'GOOD';
  if (presses >= 1) return 'BAD';
  return 'MISS';
}
