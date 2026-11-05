import { z } from 'zod';
import { AUDIO_LIMITS, BPM_RANGE, CHART_FORMAT } from './constants';

const intMs = z.number().int();

export const chartNoteSchema = z.object({
  id: z.string().min(1).max(128),
  hitAtMs: intMs,
  source: z.enum(['generated', 'manual']),
  reason: z.string().max(64).optional(),
  type: z.string().max(32).optional(),
  durationMs: z.number().int().positive().optional(),
});

export const chorusSectionSchema = z.object({
  id: z.string().min(1).max(128),
  startMs: intMs,
  endMs: intMs,
  confidence: z.number().min(0).max(1),
  source: z.enum(['detected', 'manual']),
});

export const chartLevelSchema = z.object({
  displayName: z.string().min(1).max(64),
  notes: z.array(chartNoteSchema).max(AUDIO_LIMITS.maxNotesPerLevel),
});

/**
 * formatVersion 1 の構造スキーマ。
 * 意味的検証（曲内か、重複か、パス安全か等）は validate.ts で行う。
 */
export const chartFileV1Schema = z.object({
  format: z.literal(CHART_FORMAT),
  formatVersion: z.literal(1),
  trackId: z.string().min(1).max(64),
  title: z.string().max(256),
  artist: z.string().max(256),
  audioFile: z.string().min(1).max(255),
  audioSha256: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 は64文字の小文字16進数である必要があります'),
  durationMs: z.number().int().positive(),
  bpm: z.number().min(BPM_RANGE.min).max(BPM_RANGE.max),
  offsetMs: intMs,
  analysis: z.object({
    engineVersion: z.string().min(1).max(64),
    analyzedAt: z.string().min(1).max(64),
  }),
  choruses: z.array(chorusSectionSchema).max(AUDIO_LIMITS.maxChoruses),
  levels: z.object({
    '1': chartLevelSchema,
    '2': chartLevelSchema,
    '3': chartLevelSchema,
    '4': chartLevelSchema,
  }),
  /** 任意: 生成ルール（エディターが書き出す。ゲームは参照しなくてよい） */
  generationRules: z
    .object({
      crossLevelExclusionMs: z.number().int().min(0).max(10000),
      levelPriority: z.array(z.number().int().min(1).max(4)).max(4),
      crossLevelNotesAreExclusive: z.boolean(),
    })
    .optional(),
});

/** format と formatVersion だけを先に読むためのスキーマ */
export const chartHeaderSchema = z.object({
  format: z.string(),
  formatVersion: z.number(),
});
