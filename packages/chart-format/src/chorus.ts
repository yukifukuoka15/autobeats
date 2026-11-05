import type { ChorusSection } from './types';

/**
 * 重なるまたは接するサビ区間を結合して、開始順に並べた新しい配列を返す。
 * 結合後の confidence は最大値、source は manual が含まれれば manual。
 * 曲の範囲外は切り詰め、長さ 0 以下になった区間は捨てる。
 */
export function normalizeChoruses(sections: readonly ChorusSection[], durationMs: number): ChorusSection[] {
  const clipped = sections
    .map((s) => ({
      ...s,
      startMs: Math.max(0, Math.round(s.startMs)),
      endMs: Math.min(durationMs, Math.round(s.endMs)),
    }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const result: ChorusSection[] = [];
  for (const s of clipped) {
    const last = result[result.length - 1];
    if (last && s.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, s.endMs);
      last.confidence = Math.max(last.confidence, s.confidence);
      if (s.source === 'manual') last.source = 'manual';
    } else {
      result.push({ ...s });
    }
  }
  return result;
}

export function hasOverlappingChoruses(sections: readonly ChorusSection[]): boolean {
  const sorted = [...sections].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startMs < sorted[i - 1]!.endMs) return true;
  }
  return false;
}

export function isInChorus(sections: readonly ChorusSection[], timeMs: number): boolean {
  for (const s of sections) {
    if (timeMs >= s.startMs && timeMs < s.endMs) return true;
  }
  return false;
}
