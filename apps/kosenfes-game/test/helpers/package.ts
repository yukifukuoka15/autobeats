import { CHART_FORMAT, serializeChart, type ChartFile, type ChartNote } from '@autobeats/chart-format';
import { sha256Buffer } from '@autobeats/chart-format/node';
import { encodeWav16, synthesizeClickTrack } from '@autobeats/audio-analysis';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface TestPackageOptions {
  trackId?: string;
  title?: string;
  durationSec?: number;
  bpm?: number;
  /** 各レベルの hitAtMs */
  notes?: Partial<Record<'1' | '2' | '3' | '4', number[]>>;
}

/** 合成クリック音 + chart.json のテスト用パッケージを dir に作る */
export async function writeTestPackage(dir: string, options: TestPackageOptions = {}): Promise<{ chart: ChartFile; audio: Uint8Array }> {
  const durationSec = options.durationSec ?? 8;
  const bpm = options.bpm ?? 120;
  const sampleRate = 22050;
  const pcm = synthesizeClickTrack({ bpm, durationSec, sampleRate });
  const audio = encodeWav16([pcm], sampleRate);
  const durationMs = Math.round(durationSec * 1000);
  const beatMs = 60000 / bpm;
  const defaultNotes: number[] = [];
  for (let t = 3000; t < durationMs - 500; t += beatMs) defaultNotes.push(Math.round(t));
  const mk = (times: number[], level: number): ChartNote[] => times.map((t, i) => ({ id: `l${level}-note-${i + 1}`, hitAtMs: t, source: 'generated', reason: 'beat' }));
  const chart: ChartFile = {
    format: CHART_FORMAT,
    formatVersion: 1,
    trackId: options.trackId ?? 'test-track',
    title: options.title ?? 'テスト曲',
    artist: '',
    audioFile: 'audio.wav',
    audioSha256: sha256Buffer(audio),
    durationMs,
    bpm,
    offsetMs: 0,
    analysis: { engineVersion: 'test', analyzedAt: new Date().toISOString() },
    choruses: [{ id: 'chorus-1', startMs: Math.round(durationMs / 2), endMs: durationMs - 100, confidence: 0.9, source: 'detected' }],
    levels: {
      '1': { displayName: 'LEVEL 1', notes: mk(options.notes?.['1'] ?? defaultNotes.filter((_, i) => i % 2 === 0), 1) },
      '2': { displayName: 'LEVEL 2', notes: mk(options.notes?.['2'] ?? defaultNotes, 2) },
      '3': { displayName: 'LEVEL 3', notes: mk(options.notes?.['3'] ?? defaultNotes, 3) },
      '4': { displayName: 'LEVEL 4', notes: mk(options.notes?.['4'] ?? defaultNotes, 4) },
    },
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'audio.wav'), audio);
  await writeFile(path.join(dir, 'chart.json'), serializeChart(chart));
  return { chart, audio };
}
