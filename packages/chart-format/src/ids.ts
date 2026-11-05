import type { LevelNumber } from './types';

export function makeNoteId(level: LevelNumber, seq: number): string {
  return `l${level}-note-${seq}`;
}

export function makeChorusId(seq: number): string {
  return `chorus-${seq}`;
}

/** 既存IDと衝突しない次の連番を返す */
export function nextSeq(existingIds: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const id of existingIds) {
    if (id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return max + 1;
}
