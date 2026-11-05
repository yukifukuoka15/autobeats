import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RankingEntry, RankingRow } from '../../shared/types';
import { readJsonFile, writeJsonFile } from './jsonStore';

export const RANKING_TOP_N = 10;
export const MAX_NAME_LENGTH = 20;

const countsSchema = z.object({ PERFECT: z.number().int().min(0), GOOD: z.number().int().min(0), BAD: z.number().int().min(0), MISS: z.number().int().min(0) });

export const rankingEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().max(MAX_NAME_LENGTH),
  score: z.number().int().min(0),
  maxCombo: z.number().int().min(0),
  counts: countsSchema,
  playedAt: z.string(),
});

export const rankingsFileSchema = z.object({
  version: z.literal(1),
  rankings: z.record(z.string(), z.array(rankingEntrySchema)),
});

type RankingsFile = z.infer<typeof rankingsFileSchema>;

function emptyFile(): RankingsFile {
  return { version: 1, rankings: {} };
}

/** スコア降順（同点は先に登録した方が上だが順位は同じ） */
export function sortEntries(entries: readonly RankingEntry[]): RankingEntry[] {
  return [...entries].sort((a, b) => b.score - a.score || b.maxCombo - a.maxCombo || a.playedAt.localeCompare(b.playedAt));
}

/** 同点は同順位（1,1,3 …） */
export function withRanks(entries: readonly RankingEntry[]): RankingRow[] {
  const sorted = sortEntries(entries);
  const rows: RankingRow[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    const rank = i > 0 && sorted[i - 1]!.score === e.score ? rows[i - 1]!.rank : i + 1;
    rows.push({ ...e, rank });
  }
  return rows;
}

/** 新しいスコアが登録された場合の順位（上位 N に入らなければ null） */
export function provisionalRank(entries: readonly RankingEntry[], score: number): number | null {
  // 同点は同順位: 自分より高いスコアの数 + 1
  const better = entries.filter((e) => e.score > score).length;
  const rank = better + 1;
  return rank <= RANKING_TOP_N ? rank : null;
}

export function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

export class RankingsStore {
  constructor(private readonly userDataDir: string) {}

  get filePath(): string {
    return path.join(this.userDataDir, 'rankings.json');
  }

  private async read(): Promise<RankingsFile> {
    const r = await readJsonFile(this.filePath, rankingsFileSchema, emptyFile);
    return r.value;
  }

  async get(key: string): Promise<RankingRow[]> {
    const file = await this.read();
    return withRanks(file.rankings[key] ?? []);
  }

  async keys(): Promise<string[]> {
    return Object.keys((await this.read()).rankings);
  }

  /** 破壊的変更の前にバックアップを取る */
  async backup(): Promise<string | null> {
    try {
      await fsp.access(this.filePath);
    } catch {
      return null;
    }
    const target = path.join(this.userDataDir, `rankings.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fsp.copyFile(this.filePath, target);
    return target;
  }

  /** スコアを登録し、上位 N 件だけ保持する。戻り値は確定順位（圏外なら null） */
  async register(key: string, input: Omit<RankingEntry, 'id' | 'playedAt' | 'name'> & { name: string; playedAt?: string }): Promise<{ rank: number | null; entry: RankingEntry }> {
    const file = await this.read();
    const list = file.rankings[key] ?? [];
    const entry: RankingEntry = {
      id: randomUUID(),
      name: sanitizeName(input.name),
      score: input.score,
      maxCombo: input.maxCombo,
      counts: { ...input.counts },
      playedAt: input.playedAt ?? new Date().toISOString(),
    };
    const rank = provisionalRank(list, entry.score);
    if (rank === null) return { rank: null, entry };
    const next = sortEntries([...list, entry]).slice(0, RANKING_TOP_N);
    file.rankings[key] = next;
    await writeJsonFile(this.filePath, file);
    return { rank, entry };
  }

  async rename(key: string, id: string, name: string): Promise<boolean> {
    const file = await this.read();
    const list = file.rankings[key];
    const target = list?.find((e) => e.id === id);
    if (!target) return false;
    await this.backup();
    target.name = sanitizeName(name);
    await writeJsonFile(this.filePath, file);
    return true;
  }

  async remove(key: string, id: string): Promise<boolean> {
    const file = await this.read();
    const list = file.rankings[key];
    if (!list || !list.some((e) => e.id === id)) return false;
    await this.backup();
    file.rankings[key] = list.filter((e) => e.id !== id);
    await writeJsonFile(this.filePath, file);
    return true;
  }
}
