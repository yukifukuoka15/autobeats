import type { ChartNote } from './types';

export function isMashNote(n: Pick<ChartNote, 'type'>): boolean {
  return n.type === 'mash';
}

/** ヒットの終了時刻（通常ヒットは hitAtMs、連打は hitAtMs + durationMs） */
export function noteEndMs(n: Pick<ChartNote, 'hitAtMs' | 'type' | 'durationMs'>): number {
  return n.type === 'mash' && n.durationMs ? n.hitAtMs + n.durationMs : n.hitAtMs;
}

/** 2 つの区間 [aStart, aEnd] と [bStart, bEnd] の最小距離（重なっていれば 0） */
export function spanDistanceMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (aEnd < bStart) return bStart - aEnd;
  if (bEnd < aStart) return aStart - bEnd;
  return 0;
}
