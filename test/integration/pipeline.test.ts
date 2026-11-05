/**
 * アプリに依存しない共通パイプラインの統合テスト:
 * WAV フィクスチャ → 解析 → 4レベル生成 → 譜面 JSON → パッケージ書き出し → 再検証。
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHART_FORMAT,
  DEFAULT_LEVEL_SETTINGS,
  LEVEL_DISPLAY_NAMES,
  LEVEL_NUMBERS,
  parseAndValidateChart,
  sanitizeTrackId,
  serializeChart,
  validateChart,
  verifyChartPackage,
  type ChartFile,
} from '@autobeats/chart-format';
import { nodePackageFs, sha256File } from '@autobeats/chart-format/node';
import { analyzeAudio, decodeWav, generateAllLevels } from '@autobeats/audio-analysis';

const fixture = path.resolve(__dirname, '../../fixtures/generated/song.wav');

describe('共通パイプライン', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'autobeats-pipeline-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('WAV → 解析 → 4レベル生成 → 書き出し → 再検証 まで完走する', async () => {
    expect(existsSync(fixture), 'npm run fixtures を実行してください').toBe(true);
    const wav = decodeWav(new Uint8Array(await readFile(fixture)));
    const analysis = await analyzeAudio({ sampleRate: wav.sampleRate, channels: wav.channels });
    expect(Math.abs(analysis.bpm - 120)).toBeLessThan(1.5);
    expect(analysis.choruses.length).toBeGreaterThan(0);

    const levels = generateAllLevels({ analysis, choruses: analysis.choruses, durationMs: analysis.durationMs });
    const trackId = sanitizeTrackId('Fixture Song');
    const chart: ChartFile = {
      format: CHART_FORMAT,
      formatVersion: 1,
      trackId,
      title: 'Fixture Song',
      artist: '',
      audioFile: 'audio.wav',
      audioSha256: await sha256File(fixture),
      durationMs: analysis.durationMs,
      bpm: analysis.bpm,
      offsetMs: analysis.offsetMs,
      analysis: { engineVersion: analysis.engineVersion, analyzedAt: analysis.analyzedAt },
      choruses: analysis.choruses,
      levels: {
        '1': { displayName: LEVEL_DISPLAY_NAMES[1], notes: levels[1]! },
        '2': { displayName: LEVEL_DISPLAY_NAMES[2], notes: levels[2]! },
        '3': { displayName: LEVEL_DISPLAY_NAMES[3], notes: levels[3]! },
        '4': { displayName: LEVEL_DISPLAY_NAMES[4], notes: levels[4]! },
      },
    };
    const minGapMsByLevel = { '1': DEFAULT_LEVEL_SETTINGS[1].minGapMs, '2': DEFAULT_LEVEL_SETTINGS[2].minGapMs, '3': DEFAULT_LEVEL_SETTINGS[3].minGapMs, '4': DEFAULT_LEVEL_SETTINGS[4].minGapMs };
    const validated = validateChart(chart, { minGapMsByLevel });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    // 自動生成は最小間隔を守るので間隔警告は出ない
    expect(validated.warnings.filter((w) => w.code === 'note-min-gap')).toHaveLength(0);
    for (const l of LEVEL_NUMBERS) expect(validated.chart.levels[String(l) as '1'].notes.length).toBeGreaterThan(0);

    const dir = path.join(root, trackId);
    await mkdir(dir);
    await writeFile(path.join(dir, 'chart.json'), serializeChart(validated.chart));
    await copyFile(fixture, path.join(dir, 'audio.wav'));

    const verified = await verifyChartPackage(dir, nodePackageFs, { minGapMsByLevel });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.pkg.chart.trackId).toBe(trackId);
    expect(verified.pkg.audioBytes).toBeGreaterThan(0);

    // テキストエディタでも読めるよう整形された JSON
    const text = await readFile(path.join(dir, 'chart.json'), 'utf8');
    expect(text.startsWith('{\n  "format": "kosen-rhythm-chart"')).toBe(true);
    const reparsed = parseAndValidateChart(text);
    expect(reparsed.ok).toBe(true);
  });
});
