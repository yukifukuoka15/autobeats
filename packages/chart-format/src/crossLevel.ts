import { CROSS_LEVEL_EXCLUSION_MS, LEVEL_KEYS } from './constants';
import { noteEndMs, spanDistanceMs } from './noteSpan';
import type { ChartNote, LevelKey, LevelNumber } from './types';

/** 使用済み時刻（他レベルの確定ヒット）。連打は durationMs を持ち、区間全体を占有する */
export interface UsedNoteTime {
  level: LevelNumber;
  hitAtMs: number;
  /** 連打の長さ（通常ヒットは省略） */
  durationMs?: number;
  /** 編集時に自分自身を除外するための ID（任意） */
  id?: string;
}

/** 難易度間の重複判定: |a - b| <= exclusionMs（境界を含む） */
export function isCrossLevelConflict(aMs: number, bMs: number, exclusionMs: number = CROSS_LEVEL_EXCLUSION_MS): boolean {
  return Math.abs(aMs - bMs) <= exclusionMs;
}

/** 区間同士の難易度間重複判定（連打対応）: 区間の最小距離 <= exclusionMs */
export function isCrossLevelSpanConflict(aStart: number, aEnd: number, bStart: number, bEnd: number, exclusionMs: number = CROSS_LEVEL_EXCLUSION_MS): boolean {
  return spanDistanceMs(aStart, aEnd, bStart, bEnd) <= exclusionMs;
}

/**
 * candidate（点または区間）が currentLevel 以外のレベルの使用済み時刻と重複するか。
 * usedTimes は順不同でよい。
 */
export function conflictsWithOtherLevel(candidateMs: number, currentLevel: LevelNumber, usedTimes: readonly UsedNoteTime[], exclusionMs: number = CROSS_LEVEL_EXCLUSION_MS, candidateDurationMs = 0): boolean {
  const cEnd = candidateMs + Math.max(0, candidateDurationMs);
  return usedTimes.some((used) => used.level !== currentLevel && isCrossLevelSpanConflict(candidateMs, cEnd, used.hitAtMs, used.hitAtMs + (used.durationMs ?? 0), exclusionMs));
}

export interface CrossLevelConflictHit {
  level: LevelNumber;
  id: string;
  hitAtMs: number;
  /** |candidate - hitAtMs| */
  diffMs: number;
}

/**
 * candidateMs と最も近い他レベルの音符を返す（重複していなければ null）。
 * excludeIds に含まれる音符（移動中の自分自身など）は無視する。
 */
export function findNearestCrossLevelConflict(
  candidateMs: number,
  currentLevel: LevelNumber,
  levels: Readonly<Record<LevelKey, { notes: readonly ChartNote[] }>>,
  exclusionMs: number = CROSS_LEVEL_EXCLUSION_MS,
  excludeIds?: ReadonlySet<string>,
  candidateDurationMs = 0,
): CrossLevelConflictHit | null {
  let best: CrossLevelConflictHit | null = null;
  const cEnd = candidateMs + Math.max(0, candidateDurationMs);
  for (const k of LEVEL_KEYS) {
    const level = Number(k) as LevelNumber;
    if (level === currentLevel) continue;
    for (const n of levels[k].notes) {
      if (excludeIds?.has(n.id)) continue;
      const diff = spanDistanceMs(candidateMs, cEnd, n.hitAtMs, noteEndMs(n));
      if (diff <= exclusionMs && (best === null || diff < best.diffMs)) best = { level, id: n.id, hitAtMs: n.hitAtMs, diffMs: diff };
    }
  }
  return best;
}

export interface CrossLevelConflictPair {
  /** 小さい方のレベル */
  levelA: LevelNumber;
  noteA: ChartNote;
  levelB: LevelNumber;
  noteB: ChartNote;
  diffMs: number;
}

export type LevelPairKey = `${LevelNumber}-${LevelNumber}`;

export interface CrossLevelReport {
  pairs: CrossLevelConflictPair[];
  /** 'L1-L2' 形式ではなく '1-2' 形式のキーで件数 */
  countsByPair: Record<LevelPairKey, number>;
  total: number;
}

/** 全レベル組み合わせの重複を列挙する（各レベルの notes は順不同でよい） */
export function findCrossLevelConflicts(levels: Readonly<Record<LevelKey, { notes: readonly ChartNote[] }>>, exclusionMs: number = CROSS_LEVEL_EXCLUSION_MS): CrossLevelReport {
  const sorted = {} as Record<LevelKey, ChartNote[]>;
  for (const k of LEVEL_KEYS) sorted[k] = [...levels[k].notes].sort((a, b) => a.hitAtMs - b.hitAtMs);
  const pairs: CrossLevelConflictPair[] = [];
  const countsByPair = {} as Record<LevelPairKey, number>;
  for (let i = 0; i < LEVEL_KEYS.length; i++) {
    for (let j = i + 1; j < LEVEL_KEYS.length; j++) {
      const ka = LEVEL_KEYS[i]!;
      const kb = LEVEL_KEYS[j]!;
      const la = Number(ka) as LevelNumber;
      const lb = Number(kb) as LevelNumber;
      const key: LevelPairKey = `${la}-${lb}`;
      let count = 0;
      const a = sorted[ka];
      const b = sorted[kb];
      // 連打は区間を持つため、開始順の走査に区間長の最大値を足した窓で候補を取る
      const maxSpanB = b.reduce((m, n) => Math.max(m, noteEndMs(n) - n.hitAtMs), 0);
      let bi = 0;
      for (const na of a) {
        const aEnd = noteEndMs(na);
        while (bi < b.length && noteEndMs(b[bi]!) < na.hitAtMs - exclusionMs && b[bi]!.hitAtMs + maxSpanB < na.hitAtMs - exclusionMs) bi++;
        for (let x = bi; x < b.length && b[x]!.hitAtMs <= aEnd + exclusionMs; x++) {
          const nb = b[x]!;
          const diff = spanDistanceMs(na.hitAtMs, aEnd, nb.hitAtMs, noteEndMs(nb));
          if (diff > exclusionMs) continue;
          pairs.push({ levelA: la, noteA: na, levelB: lb, noteB: nb, diffMs: diff });
          count++;
        }
      }
      countsByPair[key] = count;
    }
  }
  return { pairs, countsByPair, total: pairs.length };
}

/** 全レベルの音符を UsedNoteTime 配列へ変換する */
export function usedTimesOf(levels: Readonly<Record<LevelKey, { notes: readonly ChartNote[] }>>, only?: readonly LevelNumber[]): UsedNoteTime[] {
  const out: UsedNoteTime[] = [];
  for (const k of LEVEL_KEYS) {
    const level = Number(k) as LevelNumber;
    if (only && !only.includes(level)) continue;
    for (const n of levels[k].notes) out.push({ level, hitAtMs: n.hitAtMs, id: n.id, ...(n.type === 'mash' && n.durationMs ? { durationMs: n.durationMs } : {}) });
  }
  return out;
}
