import type { LevelKey } from '@autobeats/chart-format';
import { LEVEL_KEYS } from '@autobeats/chart-format';

export const LANE_HEIGHTS = { ruler: 26, chorus: 18, waveform: 112, level: 64 } as const;
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 4000;

export type Lane = { kind: 'ruler' | 'chorus' | 'waveform'; y: number; h: number } | { kind: 'level'; level: LevelKey; y: number; h: number };

export function buildLanes(visibleLevels: Record<LevelKey, boolean>): Lane[] {
  const lanes: Lane[] = [];
  let y = 0;
  lanes.push({ kind: 'ruler', y, h: LANE_HEIGHTS.ruler });
  y += LANE_HEIGHTS.ruler;
  lanes.push({ kind: 'chorus', y, h: LANE_HEIGHTS.chorus });
  y += LANE_HEIGHTS.chorus;
  lanes.push({ kind: 'waveform', y, h: LANE_HEIGHTS.waveform });
  y += LANE_HEIGHTS.waveform;
  for (const k of LEVEL_KEYS) {
    if (!visibleLevels[k]) continue;
    lanes.push({ kind: 'level', level: k, y, h: LANE_HEIGHTS.level });
    y += LANE_HEIGHTS.level;
  }
  return lanes;
}

export function totalHeight(lanes: Lane[]): number {
  const last = lanes[lanes.length - 1];
  return last ? last.y + last.h : 0;
}

export function laneAt(lanes: Lane[], y: number): Lane | null {
  for (const l of lanes) if (y >= l.y && y < l.y + l.h) return l;
  return null;
}

export interface TimeScale {
  scrollMs: number;
  pxPerMs: number;
}

export function makeScale(zoomPxPerSec: number, scrollMs: number): TimeScale {
  return { scrollMs, pxPerMs: zoomPxPerSec / 1000 };
}

export function xOf(scale: TimeScale, ms: number): number {
  return (ms - scale.scrollMs) * scale.pxPerMs;
}

export function msOf(scale: TimeScale, x: number): number {
  return scale.scrollMs + x / scale.pxPerMs;
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** カーソル位置を固定してズームしたときの新しい scrollMs */
export function zoomAround(zoomPxPerSec: number, scrollMs: number, cursorX: number, factor: number, durationMs: number, widthPx: number): { zoomPxPerSec: number; scrollMs: number } {
  const next = clampZoom(zoomPxPerSec * factor);
  const msAtCursor = msOf(makeScale(zoomPxPerSec, scrollMs), cursorX);
  const nextScroll = msAtCursor - cursorX / (next / 1000);
  return { zoomPxPerSec: next, scrollMs: clampScroll(nextScroll, next, durationMs, widthPx) };
}

export function clampScroll(scrollMs: number, zoomPxPerSec: number, durationMs: number, widthPx: number): number {
  const visibleMs = widthPx / (zoomPxPerSec / 1000);
  const max = Math.max(0, durationMs - visibleMs * 0.5);
  return Math.min(max, Math.max(0, scrollMs));
}

/** 目盛りの間隔（ms）を、ラベルが約 minLabelPx 以上離れるよう選ぶ */
export function pickTickStepMs(pxPerMs: number, minLabelPx = 70): { major: number; minor: number } {
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
  for (const c of candidates) if (c * pxPerMs >= minLabelPx) return { major: c, minor: c / (c === 15000 || c === 30000 ? 3 : c === 60000 || c === 120000 || c === 300000 ? 4 : 5) };
  return { major: 600000, minor: 120000 };
}

/** ソート済み配列から [fromMs, toMs] に含まれる要素のインデックス範囲 */
export function visibleRange(sorted: ArrayLike<number>, fromMs: number, toMs: number): [number, number] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < fromMs) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= toMs) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo];
}
