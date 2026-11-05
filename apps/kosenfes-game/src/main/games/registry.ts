import { NEON_HIT_GAME_ID, buildFixedRankingKey, type ChorusSection } from '@autobeats/chart-format';
import type { GameMode } from '../../shared/types';

export interface FixedChart {
  chartId: string;
  title: string;
  bpm: number;
  durationMs: number;
  notes: number[];
  choruses: ChorusSection[];
}

export interface GameDefinition {
  id: string;
  displayName: string;
  modes: readonly GameMode[];
}

/** ゲーム登録。ID は安定させる（ランキングキー・保存データの互換性） */
export const GAMES: readonly GameDefinition[] = [{ id: NEON_HIT_GAME_ID, displayName: 'ネオンヒット', modes: ['fixed', 'song'] }];

export const FIXED_CHART_ID = 'default-v1';

/**
 * 固定譜面モードの譜面（決定的な定数パターン、音楽ファイルなし）。
 * 120 BPM・60 秒。4小節ごとに密度が変わるパターン。
 */
export function buildFixedChart(): FixedChart {
  const bpm = 120;
  const beatMs = 60000 / bpm;
  const durationMs = 60000;
  const notes: number[] = [];
  const startMs = 3000; // 最初の 3 秒は出現時間の確保
  for (let bar = 0; bar * beatMs * 4 + startMs < durationMs - 2000; bar++) {
    const barStart = startMs + bar * beatMs * 4;
    const phase = Math.floor(bar / 4) % 3;
    for (let beat = 0; beat < 4; beat++) {
      const t = barStart + beat * beatMs;
      if (phase === 0) {
        if (beat === 0 || beat === 2) notes.push(Math.round(t));
      } else if (phase === 1) {
        notes.push(Math.round(t));
      } else {
        notes.push(Math.round(t));
        if (beat === 1 || beat === 3) notes.push(Math.round(t + beatMs / 2));
      }
    }
  }
  const choruses: ChorusSection[] = [{ id: 'fixed-chorus', startMs: 35000, endMs: 51000, confidence: 1, source: 'manual' }];
  return { chartId: FIXED_CHART_ID, title: '固定譜面（デフォルト）', bpm, durationMs, notes: notes.filter((t) => t < durationMs), choruses };
}

export function fixedRankingKey(): string {
  return buildFixedRankingKey(NEON_HIT_GAME_ID, FIXED_CHART_ID);
}
