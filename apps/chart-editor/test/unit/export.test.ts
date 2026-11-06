import { verifyChartPackage } from '@autobeats/chart-format';
import { nodePackageFs, sha256Buffer } from '@autobeats/chart-format/node';
import { encodeWav16, sine } from '@autobeats/audio-analysis';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as cmd from '../../src/renderer/src/store/document';
import { documentToChart, exportChartJson, exportGamePackage } from '../../src/main/services/exportPackage';
import { audioMeta, syntheticAnalysis } from './document.test';

describe('exportGamePackage', () => {
  let dir: string;
  let audioPath: string;
  let doc: ReturnType<typeof cmd.createEmptyDocument>;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'autobeats-export-'));
    const wav = encodeWav16([sine(440, 2, 8000)], 8000);
    audioPath = path.join(dir, 'src.wav');
    await writeFile(audioPath, wav);
    doc = cmd.documentWithAudio(cmd.createEmptyDocument('independent'), { ...audioMeta, sha256: sha256Buffer(wav), durationMs: 2000 });
    doc = cmd.regenerateLevels(cmd.applyAnalysis(doc, syntheticAnalysis(2000)), ['1', '2', '3', '4'], 'replace').doc;
    doc = { ...doc, trackId: 'my-song', choruses: [] };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('フォルダを書き出し、再検証に成功する。既存フォルダは上書きしない', async () => {
    const out = path.join(dir, 'out');
    const r = await exportGamePackage(doc, audioPath, out, 'ask');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.dir).toBe(path.join(out, 'my-song'));
    const chart = JSON.parse(await readFile(path.join(r.dir, 'chart.json'), 'utf8'));
    expect(chart.audioFile).toBe('audio.wav');
    expect(await readFile(path.join(r.dir, 'audio.wav'))).toEqual(await readFile(audioPath));
    const verified = await verifyChartPackage(r.dir, nodePackageFs);
    expect(verified.ok).toBe(true);
    const again = await exportGamePackage(doc, audioPath, out, 'ask');
    expect(again.status).toBe('exists');
    const renamed = await exportGamePackage(doc, audioPath, out, 'rename');
    expect(renamed.status).toBe('ok');
    if (renamed.status === 'ok') expect(renamed.dir).toBe(path.join(out, 'my-song (2)'));
    const over = await exportGamePackage(doc, audioPath, out, 'overwrite');
    expect(over.status).toBe('ok');
  });

  it('検証エラー（重なるサビ・不正ID）と音声欠落を拒否する', async () => {
    const out = path.join(dir, 'out2');
    const overlap = { ...doc, choruses: [{ id: 'a', startMs: 0, endMs: 1000, confidence: 1, source: 'manual' as const }, { id: 'b', startMs: 500, endMs: 1500, confidence: 1, source: 'manual' as const }] };
    const r1 = await exportGamePackage(overlap, audioPath, out, 'ask');
    expect(r1.status).toBe('error');
    if (r1.status === 'error') expect(r1.errors.some((e) => e.code === 'chorus-overlap')).toBe(true);
    const badId = { ...doc, trackId: '../etc' };
    expect((await exportGamePackage(badId, audioPath, out, 'ask')).status).toBe('error');
    const missing = await exportGamePackage(doc, path.join(dir, 'nope.wav'), out, 'ask');
    expect(missing.status).toBe('error');
    const noAudio = await exportGamePackage({ ...doc, audio: null }, audioPath, out, 'ask');
    expect(noAudio.status).toBe('error');
  });

  it('chart.json だけを書き出せる', async () => {
    const p = path.join(dir, 'chart.json');
    const r = await exportChartJson(doc, p);
    expect(r.ok).toBe(true);
    const chart = JSON.parse(await readFile(p, 'utf8'));
    expect(chart.format).toBe('kosen-rhythm-chart');
    expect(documentToChart(doc, 'audio.wav').levels['1'].notes.length).toBe(chart.levels['1'].notes.length);
  });
});
