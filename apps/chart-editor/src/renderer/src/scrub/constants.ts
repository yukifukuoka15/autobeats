/** キーボードスクラブの設定値（一元管理） */
export const SCRUB = {
  /** 通常の短押し移動量 */
  stepMs: 20,
  /** Shift */
  stepShiftMs: 100,
  /** Option */
  stepOptionMs: 1,
  /** Shift + Option */
  stepShiftOptionMs: 500,
  /** これ未満で離したら短押し。これ以上押し続けると長押しスクラブ */
  holdDelayMs: 300,
  /** 長押し中の繰り返し間隔 */
  repeatIntervalMs: 60,
  /** 長押し中の 1 回あたりの移動量（修飾キーなし） */
  repeatStepMs: 20,
  /** スクラブ音声片の長さ */
  grainMinDurationMs: 40,
  grainMaxDurationMs: 100,
  /** 音声片の頭と末尾のフェード */
  fadeMs: 5,
  /** 同時に保持するスクラブ音声ノードの上限 */
  maxActiveGrains: 3,
  /** 再生ヘッドが表示幅のこの比率の端に入ったら追従する */
  scrollMarginRatio: 0.1,
} as const;

export interface ScrubModifiers {
  shift: boolean;
  /** macOS の Option（KeyboardEvent.altKey） */
  option: boolean;
}

/** 修飾キーから移動量を決める */
export function scrubStepFor(mods: ScrubModifiers): number {
  if (mods.shift && mods.option) return SCRUB.stepShiftOptionMs;
  if (mods.shift) return SCRUB.stepShiftMs;
  if (mods.option) return SCRUB.stepOptionMs;
  return SCRUB.stepMs;
}

/** 移動量に応じた音声片の長さ（40～100ms） */
export function grainDurationFor(stepMs: number): number {
  return Math.min(SCRUB.grainMaxDurationMs, Math.max(SCRUB.grainMinDurationMs, Math.abs(stepMs) * 2));
}
