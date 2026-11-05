import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeChart, verifyChartPackage } from '../src';
import { nodePackageFs, sha256Buffer } from '../src/node';
import { sampleChart } from './validate.test';

describe('verifyChartPackage', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'chart-pkg-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writePkg(name: string, audio: Uint8Array, mutate?: (c: ReturnType<typeof sampleChart>) => void) {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    const chart = sampleChart({ audioSha256: sha256Buffer(audio) });
    mutate?.(chart);
    await writeFile(path.join(dir, 'audio.mp3'), audio);
    await writeFile(path.join(dir, 'chart.json'), serializeChart(chart));
    return dir;
  }

  it('正常なパッケージを検証できる', async () => {
    const dir = await writePkg('ok', new Uint8Array([1, 2, 3, 4]));
    const r = await verifyChartPackage(dir, nodePackageFs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.audioBytes).toBe(4);
    expect(r.pkg.chart.trackId).toBe('sample-track');
  });

  it('SHA-256 不一致を拒否する', async () => {
    const dir = await writePkg('bad-sha', new Uint8Array([1, 2, 3, 4]), (c) => {
      c.audioSha256 = 'f'.repeat(64);
    });
    const r = await verifyChartPackage(dir, nodePackageFs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('sha256-mismatch');
  });

  it('音声欠落を拒否する', async () => {
    const dir = await writePkg('missing', new Uint8Array([1]), (c) => {
      c.audioFile = 'other.mp3';
    });
    const r = await verifyChartPackage(dir, nodePackageFs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('audio-missing');
  });

  it('シンボリックリンクでフォルダ外を参照すると拒否する', async () => {
    const outside = path.join(root, 'outside.mp3');
    const bytes = new Uint8Array([9, 9, 9]);
    await writeFile(outside, bytes);
    const dir = path.join(root, 'link');
    await mkdir(dir);
    await symlink(outside, path.join(dir, 'audio.mp3'));
    await writeFile(path.join(dir, 'chart.json'), serializeChart(sampleChart({ audioSha256: sha256Buffer(bytes) })));
    const r = await verifyChartPackage(dir, nodePackageFs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('audio-escape');
  });

  it('chart.json 欠落・壊れた JSON・未知バージョンを拒否する', async () => {
    const dir = path.join(root, 'empty');
    await mkdir(dir);
    expect((await verifyChartPackage(dir, nodePackageFs)).ok).toBe(false);
    await writeFile(path.join(dir, 'chart.json'), '{broken');
    expect((await verifyChartPackage(dir, nodePackageFs)).ok).toBe(false);
    await writeFile(path.join(dir, 'chart.json'), JSON.stringify({ ...sampleChart(), formatVersion: 99 }));
    const r = await verifyChartPackage(dir, nodePackageFs);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('unsupported-version');
  });
});
