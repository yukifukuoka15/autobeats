import type { LevelNumber } from './types';

export interface SongRankingKeyInput {
  gameId: string;
  trackId: string;
  audioSha256: string;
  formatVersion: number;
  level: LevelNumber;
}

/**
 * 楽曲譜面モードのランキングキー。
 * 曲・音声ハッシュ・形式バージョン・レベルが1つでも違えば別ランキングになる。
 */
export function buildSongRankingKey(input: SongRankingKeyInput): string {
  return `${input.gameId}:song:${input.trackId}:${input.audioSha256}:v${input.formatVersion}:L${input.level}`;
}

/** 固定譜面モードのランキングキー */
export function buildFixedRankingKey(gameId: string, chartId: string): string {
  return `${gameId}:fixed:${chartId}`;
}

export function parseSongRankingKey(key: string): SongRankingKeyInput | null {
  const m = /^([^:]+):song:([^:]+):([0-9a-f]{64}):v(\d+):L([1-4])$/.exec(key);
  if (!m) return null;
  return {
    gameId: m[1]!,
    trackId: m[2]!,
    audioSha256: m[3]!,
    formatVersion: Number(m[4]),
    level: Number(m[5]) as LevelNumber,
  };
}
