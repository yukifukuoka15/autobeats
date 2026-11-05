import { describe, expect, it } from 'vitest';
import { buildFixedRankingKey, buildSongRankingKey, parseSongRankingKey } from '../src';

describe('ranking key', () => {
  it('曲・ハッシュ・バージョン・レベルで衝突しない', () => {
    const base = { gameId: 'neon-hit', trackId: 'song', audioSha256: 'a'.repeat(64), formatVersion: 1, level: 1 as const };
    const keys = new Set([
      buildSongRankingKey(base),
      buildSongRankingKey({ ...base, level: 2 }),
      buildSongRankingKey({ ...base, level: 3 }),
      buildSongRankingKey({ ...base, level: 4 }),
      buildSongRankingKey({ ...base, audioSha256: 'b'.repeat(64) }),
      buildSongRankingKey({ ...base, trackId: 'song2' }),
      buildSongRankingKey({ ...base, formatVersion: 2 }),
      buildFixedRankingKey('neon-hit', 'default'),
    ]);
    expect(keys.size).toBe(8);
    expect(parseSongRankingKey(buildSongRankingKey(base))).toEqual(base);
    expect(parseSongRankingKey(buildFixedRankingKey('neon-hit', 'default'))).toBeNull();
  });
});
