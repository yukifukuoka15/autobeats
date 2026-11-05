import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSongRankingKey } from '@autobeats/chart-format';
import { LibraryStore, libraryDirName } from '../../src/main/services/library';
import { ImportService } from '../../src/main/services/importPackage';
import { RankingsStore, provisionalRank, withRanks } from '../../src/main/services/rankings';
import { SettingsStore, defaultSettings } from '../../src/main/services/settings';
import { readJsonFile } from '../../src/main/services/jsonStore';
import { VirtualButtonDevice } from '../../src/main/device/virtual';
import { buildFixedChart } from '../../src/main/games/registry';
import { writeTestPackage } from '../helpers/package';
import { z } from 'zod';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'kosenfes-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('既定値を返し、範囲外の値を丸めて保存する', async () => {
    const store = new SettingsStore(root);
    expect((await store.get())).toEqual(defaultSettings());
    const s = await store.update({ inputOffsetMs: 255, musicVolume: 2, sfxVolume: -1, level: 3 });
    expect(s.inputOffsetMs).toBe(200);
    expect(s.musicVolume).toBe(1);
    expect(s.sfxVolume).toBe(0);
    expect(s.level).toBe(3);
    const again = new SettingsStore(root);
    expect((await again.get()).level).toBe(3);
  });

  it('壊れた settings.json は退避して既定値へ戻す', async () => {
    await writeFile(path.join(root, 'settings.json'), '{broken');
    const store = new SettingsStore(root);
    const r = await store.load();
    expect(r.recovered).toContain('settings.json');
    expect(r.settings).toEqual(defaultSettings());
    const files = await readdir(root);
    expect(files.some((f) => f.startsWith('settings.json.corrupt-'))).toBe(true);
  });
});

describe('jsonStore', () => {
  it('スキーマ不一致を退避する', async () => {
    const p = path.join(root, 'x.json');
    await writeFile(p, JSON.stringify({ a: 'str' }));
    const r = await readJsonFile(p, z.object({ a: z.number() }), () => ({ a: 1 }));
    expect(r.value).toEqual({ a: 1 });
    expect(r.recovered).toBeTruthy();
  });
});

describe('RankingsStore', () => {
  const key = buildSongRankingKey({ gameId: 'neon-hit', trackId: 't', audioSha256: 'a'.repeat(64), formatVersion: 1, level: 1 });
  const counts = { PERFECT: 1, GOOD: 0, BAD: 0, MISS: 0 };

  it('上位10件・同点同順位・バックアップ・レベル別キー', async () => {
    const store = new RankingsStore(root);
    for (let i = 0; i < 12; i++) {
      await store.register(key, { name: `p${i}`, score: i * 100, maxCombo: i, counts });
    }
    const rows = await store.get(key);
    expect(rows).toHaveLength(10);
    expect(rows[0]!.score).toBe(1100);
    expect(rows[9]!.score).toBe(200);
    const r = await store.register(key, { name: 'tie', score: 1100, maxCombo: 0, counts });
    expect(r.rank).toBe(1);
    const rows2 = await store.get(key);
    expect(rows2[0]!.rank).toBe(1);
    expect(rows2[1]!.rank).toBe(1);
    expect(rows2[2]!.rank).toBe(3);
    const out = await store.register(key, { name: 'low', score: 1, maxCombo: 0, counts });
    expect(out.rank).toBeNull();
    expect((await store.get(key)).some((e) => e.name === 'low')).toBe(false);

    const key2 = buildSongRankingKey({ gameId: 'neon-hit', trackId: 't', audioSha256: 'a'.repeat(64), formatVersion: 1, level: 2 });
    expect(await store.get(key2)).toEqual([]);

    const id = rows2[0]!.id;
    expect(await store.rename(key, id, '  名前\u0000 ')).toBe(true);
    expect((await store.get(key))[0]!.name).toBe('名前');
    expect(await store.remove(key, id)).toBe(true);
    expect((await store.get(key)).some((e) => e.id === id)).toBe(false);
    const files = await readdir(root);
    expect(files.filter((f) => f.startsWith('rankings.backup-')).length).toBeGreaterThanOrEqual(1);
  });

  it('順位計算のヘルパー', () => {
    const e = (score: number) => ({ id: String(score), name: '', score, maxCombo: 0, counts, playedAt: '2026-01-01' });
    expect(withRanks([e(10), e(30), e(30), e(20)]).map((r) => [r.score, r.rank])).toEqual([[30, 1], [30, 1], [20, 3], [10, 4]]);
    expect(provisionalRank([e(30), e(20)], 25)).toBe(2);
    expect(provisionalRank([e(30), e(20)], 30)).toBe(1);
    expect(provisionalRank(Array.from({ length: 10 }, (_, i) => e(100 + i)), 50)).toBeNull();
  });
});

describe('ImportService', () => {
  it('正常取り込み・重複・衝突（置換／別ID）', async () => {
    const userData = path.join(root, 'userData');
    const library = new LibraryStore(userData);
    const svc = new ImportService(library);
    const src = path.join(root, 'pkg');
    const { chart } = await writeTestPackage(src, { trackId: 'song-a' });
    const r1 = await svc.importFrom(src);
    expect(r1.status).toBe('imported');
    if (r1.status !== 'imported') return;
    expect(r1.entry.noteCounts['2']).toBe(chart.levels['2'].notes.length);
    const dir = path.join(library.rootDir, libraryDirName('song-a', chart.audioSha256));
    expect(JSON.parse(await readFile(path.join(dir, 'chart.json'), 'utf8')).trackId).toBe('song-a');

    // chart.json を直接指定しても同じ
    const r2 = await svc.importFrom(path.join(src, 'chart.json'));
    expect(r2.status).toBe('duplicate');
    expect((await library.list()).length).toBe(1);

    // 同じ ID・異なる音声
    const src2 = path.join(root, 'pkg2');
    const { chart: chart2 } = await writeTestPackage(src2, { trackId: 'song-a', durationSec: 9, title: '別内容' });
    const r3 = await svc.importFrom(src2);
    expect(r3.status).toBe('conflict');
    if (r3.status !== 'conflict') return;
    const r4 = await svc.resolveConflict(r3.pendingId, 'new-id', () => false);
    expect(r4.status).toBe('imported');
    if (r4.status !== 'imported') return;
    expect(r4.entry.trackId).toBe('song-a-2');
    const newDir = path.join(library.rootDir, libraryDirName('song-a-2', chart2.audioSha256));
    expect(JSON.parse(await readFile(path.join(newDir, 'chart.json'), 'utf8')).trackId).toBe('song-a-2');
    expect((await library.list()).map((e) => e.trackId).sort()).toEqual(['song-a', 'song-a-2']);

    // 置換
    const src3 = path.join(root, 'pkg3');
    const { chart: chart3 } = await writeTestPackage(src3, { trackId: 'song-a', durationSec: 10, title: '置換' });
    const r5 = await svc.importFrom(src3);
    expect(r5.status).toBe('conflict');
    if (r5.status !== 'conflict') return;
    const busy = await svc.resolveConflict(r5.pendingId, 'replace', () => true);
    expect(busy.status).toBe('rejected');
    const r6 = await svc.importFrom(src3);
    if (r6.status !== 'conflict') throw new Error('expected conflict');
    const r7 = await svc.resolveConflict(r6.pendingId, 'replace', () => false);
    expect(r7.status).toBe('imported');
    const entries = await library.list();
    expect(entries.find((e) => e.trackId === 'song-a')?.audioSha256).toBe(chart3.audioSha256);
    expect(entries.find((e) => e.trackId === 'song-a')?.title).toBe('置換');
    await expect(readdir(dir)).rejects.toThrow();
    expect(await svc.resolveConflict('nope', 'replace', () => false)).toMatchObject({ status: 'rejected' });
  });

  it('壊れた JSON・音声欠落・ハッシュ不一致・未知バージョン・シンボリックリンク・非対象ファイルを拒否する', async () => {
    const library = new LibraryStore(path.join(root, 'userData'));
    const svc = new ImportService(library);
    const expectRejected = async (p: string, fragment: string) => {
      const r = await svc.importFrom(p);
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(r.errors.join('\n')).toContain(fragment);
    };
    const broken = path.join(root, 'broken');
    await writeTestPackage(broken);
    await writeFile(path.join(broken, 'chart.json'), '{nope');
    await expectRejected(broken, 'JSON');

    const missing = path.join(root, 'missing');
    await writeTestPackage(missing);
    await rm(path.join(missing, 'audio.wav'));
    await expectRejected(missing, 'ありません');

    const mismatch = path.join(root, 'mismatch');
    await writeTestPackage(mismatch);
    await writeFile(path.join(mismatch, 'audio.wav'), new Uint8Array([1, 2, 3]));
    await expectRejected(mismatch, 'SHA-256');

    const future = path.join(root, 'future');
    const { chart } = await writeTestPackage(future);
    await writeFile(path.join(future, 'chart.json'), JSON.stringify({ ...chart, formatVersion: 99 }));
    await expectRejected(future, '非対応');

    const link = path.join(root, 'link');
    const { audio } = await writeTestPackage(link);
    await rm(path.join(link, 'audio.wav'));
    await writeFile(path.join(root, 'outside.wav'), audio);
    await symlink(path.join(root, 'outside.wav'), path.join(link, 'audio.wav'));
    await expectRejected(link, '外');

    await writeFile(path.join(root, 'other.txt'), 'x');
    await expectRejected(path.join(root, 'other.txt'), 'chart.json');
    await expectRejected(path.join(root, 'does-not-exist'), 'アクセス');
    expect(await library.list()).toEqual([]);
  });
});

describe('VirtualButtonDevice', () => {
  it('押下・解放をゲートし、LED を待機色へ戻す', async () => {
    let t = 0;
    const d = new VirtualButtonDevice(() => t);
    const events: string[] = [];
    d.on('pressed', (e) => events.push(`p${e.seq}@${e.receivedAtMs}`));
    d.on('released', (e) => events.push(`r${e.seq}`));
    expect(d.inject('pressed')).toBeNull(); // 未接続
    await d.connect();
    t = 10;
    expect(d.inject('pressed')).not.toBeNull();
    expect(d.inject('pressed')).toBeNull(); // 押しっぱなし
    expect(d.inject('released')).not.toBeNull();
    expect(d.inject('released')).toBeNull();
    expect(events).toEqual(['p1@10', 'r2']);
    const leds: string[] = [];
    d.onLed((c) => leds.push(c));
    d.setLed('dim-red', 0);
    d.setLed('white', 5);
    expect(d.currentLed).toBe('white');
    await new Promise((r) => setTimeout(r, 20));
    expect(d.currentLed).toBe('dim-red');
    expect(leds).toEqual(['dim-red', 'white', 'dim-red']);
  });
});

describe('fixed chart', () => {
  it('固定譜面は決定的で重複・範囲外がない', () => {
    const a = buildFixedChart();
    const b = buildFixedChart();
    expect(a).toEqual(b);
    expect(a.notes.length).toBeGreaterThan(50);
    expect(new Set(a.notes).size).toBe(a.notes.length);
    expect(a.notes.every((t, i) => t >= 0 && t < a.durationMs && (i === 0 || t > a.notes[i - 1]!))).toBe(true);
  });
});
