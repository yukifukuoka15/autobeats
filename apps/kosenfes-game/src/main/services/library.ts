import { LEVEL_KEYS, type ChartFile, type LevelKey } from '@autobeats/chart-format';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { LibraryEntrySummary } from '../../shared/types';
import { readJsonFile, writeJsonFile } from './jsonStore';

export const libraryEntrySchema = z.object({
  trackId: z.string().min(1).max(64),
  audioSha256: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string(),
  artist: z.string(),
  durationMs: z.number().int().positive(),
  bpm: z.number(),
  formatVersion: z.number().int(),
  audioFile: z.string(),
  noteCounts: z.object({ '1': z.number().int(), '2': z.number().int(), '3': z.number().int(), '4': z.number().int() }),
  importedAt: z.string(),
  dirName: z.string().min(1).max(128),
  verified: z.object({ ok: z.boolean(), checkedAt: z.string(), errors: z.array(z.string()) }),
});

export type LibraryEntry = z.infer<typeof libraryEntrySchema>;

export const libraryIndexSchema = z.object({
  version: z.literal(1),
  entries: z.array(libraryEntrySchema),
});

type LibraryIndex = z.infer<typeof libraryIndexSchema>;

export function libraryDirName(trackId: string, sha256: string): string {
  return `${trackId}--${sha256.slice(0, 12)}`;
}

export function entryFromChart(chart: ChartFile, dirName: string, verifiedErrors: string[] = []): LibraryEntry {
  const counts = {} as Record<LevelKey, number>;
  for (const k of LEVEL_KEYS) counts[k] = chart.levels[k].notes.length;
  const now = new Date().toISOString();
  return {
    trackId: chart.trackId,
    audioSha256: chart.audioSha256,
    title: chart.title,
    artist: chart.artist,
    durationMs: chart.durationMs,
    bpm: chart.bpm,
    formatVersion: chart.formatVersion,
    audioFile: chart.audioFile,
    noteCounts: counts,
    importedAt: now,
    dirName,
    verified: { ok: verifiedErrors.length === 0, checkedAt: now, errors: verifiedErrors },
  };
}

export function toSummary(e: LibraryEntry): LibraryEntrySummary {
  return {
    trackId: e.trackId,
    audioSha256: e.audioSha256,
    title: e.title,
    artist: e.artist,
    durationMs: e.durationMs,
    bpm: e.bpm,
    noteCounts: e.noteCounts,
    importedAt: e.importedAt,
    verified: e.verified,
  };
}

export class LibraryStore {
  constructor(private readonly userDataDir: string) {}

  get rootDir(): string {
    return path.join(this.userDataDir, 'library');
  }

  get indexPath(): string {
    return path.join(this.rootDir, 'index.json');
  }

  entryDir(entry: Pick<LibraryEntry, 'dirName'>): string {
    return path.join(this.rootDir, entry.dirName);
  }

  async read(): Promise<{ index: LibraryIndex; recovered?: string }> {
    await fsp.mkdir(this.rootDir, { recursive: true });
    const r = await readJsonFile(this.indexPath, libraryIndexSchema, () => ({ version: 1 as const, entries: [] }));
    return { index: r.value, recovered: r.recovered };
  }

  async list(): Promise<LibraryEntry[]> {
    return (await this.read()).index.entries;
  }

  async find(trackId: string, sha256?: string): Promise<LibraryEntry | undefined> {
    const entries = await this.list();
    return entries.find((e) => e.trackId === trackId && (sha256 === undefined || e.audioSha256 === sha256));
  }

  async upsert(entry: LibraryEntry): Promise<void> {
    const { index } = await this.read();
    index.entries = index.entries.filter((e) => !(e.trackId === entry.trackId && e.audioSha256 === entry.audioSha256));
    index.entries.push(entry);
    await writeJsonFile(this.indexPath, index);
  }

  async remove(trackId: string, sha256: string): Promise<LibraryEntry | undefined> {
    const { index } = await this.read();
    const target = index.entries.find((e) => e.trackId === trackId && e.audioSha256 === sha256);
    if (!target) return undefined;
    index.entries = index.entries.filter((e) => e !== target);
    await writeJsonFile(this.indexPath, index);
    await fsp.rm(this.entryDir(target), { recursive: true, force: true });
    return target;
  }

  async updateVerification(trackId: string, sha256: string, errors: string[]): Promise<void> {
    const { index } = await this.read();
    const target = index.entries.find((e) => e.trackId === trackId && e.audioSha256 === sha256);
    if (!target) return;
    target.verified = { ok: errors.length === 0, checkedAt: new Date().toISOString(), errors };
    await writeJsonFile(this.indexPath, index);
  }
}
