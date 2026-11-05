import { clampInputOffset } from '@autobeats/chart-format';
import * as path from 'node:path';
import { z } from 'zod';
import type { GameSettings } from '../../shared/types';
import { readJsonFile, writeJsonFile } from './jsonStore';

export const VIRTUAL_DEVICE_ID = 'virtual-keyboard';

export const settingsSchema = z.object({
  mode: z.enum(['fixed', 'song']),
  selectedTrackId: z.string().max(64).nullable(),
  selectedAudioSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  deviceId: z.string().min(1).max(64),
  inputOffsetMs: z.number(),
  musicVolume: z.number().min(0).max(1),
  sfxVolume: z.number().min(0).max(1),
});

export function defaultSettings(): GameSettings {
  return {
    mode: 'song',
    selectedTrackId: null,
    selectedAudioSha256: null,
    level: 1,
    deviceId: VIRTUAL_DEVICE_ID,
    inputOffsetMs: 0,
    musicVolume: 0.8,
    sfxVolume: 0.8,
  };
}

/** 範囲外の値を安全な値へ丸める */
export function normalizeSettings(input: GameSettings): GameSettings {
  return {
    ...input,
    inputOffsetMs: clampInputOffset(input.inputOffsetMs),
    musicVolume: clamp01(input.musicVolume),
    sfxVolume: clamp01(input.sfxVolume),
    level: [1, 2, 3, 4].includes(input.level) ? input.level : 1,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}

export class SettingsStore {
  private cache: GameSettings | null = null;
  constructor(private readonly userDataDir: string) {}

  get filePath(): string {
    return path.join(this.userDataDir, 'settings.json');
  }

  async load(): Promise<{ settings: GameSettings; recovered?: string }> {
    const r = await readJsonFile(this.filePath, settingsSchema, defaultSettings);
    this.cache = normalizeSettings(r.value);
    return { settings: this.cache, recovered: r.recovered };
  }

  async get(): Promise<GameSettings> {
    if (!this.cache) await this.load();
    return this.cache!;
  }

  async update(patch: Partial<GameSettings>): Promise<GameSettings> {
    const current = await this.get();
    const next = normalizeSettings({ ...current, ...patch });
    await writeJsonFile(this.filePath, next);
    this.cache = next;
    return next;
  }
}
