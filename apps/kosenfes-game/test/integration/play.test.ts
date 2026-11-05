import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JUDGE, SYNC } from '@autobeats/chart-format';
import { DeviceManager } from '../../src/main/device/manager';
import { PlayController } from '../../src/main/game/controller';
import { ImportService } from '../../src/main/services/importPackage';
import { LibraryStore, toSummary } from '../../src/main/services/library';
import { RankingsStore } from '../../src/main/services/rankings';
import { SettingsStore } from '../../src/main/services/settings';
import { writeTestPackage } from '../helpers/package';
import type { FinishedResult } from '../../src/shared/types';

const NOTES = [3000, 3500, 4000, 4500, 5000];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('取り込みからプレイ・ランキング登録まで（headless）', () => {
  let root: string;
  let clock = 0;
  const now = () => clock;
  let settings: SettingsStore;
  let library: LibraryStore;
  let rankings: RankingsStore;
  let importer: ImportService;
  let devices: DeviceManager;
  let emitted: { channel: string; payload: unknown }[];
  let controller: PlayController;
  const tokens = new Map<string, string>();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kosenfes-int-'));
    clock = 10000;
    settings = new SettingsStore(root);
    library = new LibraryStore(root);
    rankings = new RankingsStore(root);
    importer = new ImportService(library);
    devices = new DeviceManager(now);
    emitted = [];
    controller = new PlayController({
      settings,
      library,
      rankings,
      devices,
      emit: (channel, payload) => emitted.push({ channel, payload }),
      registerAudioToken: (p) => {
        tokens.set('tok', p);
        return 'tok';
      },
      revokeAudioToken: (t) => tokens.delete(t),
      now,
      tickIntervalMs: 2,
      snapshotIntervalMs: 50,
    });
  });
  afterEach(async () => {
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });

  async function importAndSelect(level: 1 | 2 | 3 | 4 = 2) {
    const pkg = path.join(root, 'pkg');
    const { chart } = await writeTestPackage(pkg, { trackId: 'int-track', durationSec: 6, notes: { '1': NOTES, '2': NOTES, '3': NOTES, '4': NOTES } });
    const r = await importer.importFrom(pkg);
    expect(r.status).toBe('imported');
    const list = (await library.list()).map(toSummary);
    expect(list).toHaveLength(1);
    await settings.update({ mode: 'song', selectedTrackId: 'int-track', selectedAudioSha256: chart.audioSha256, level, deviceId: 'virtual-keyboard' });
    return { chart, pkg };
  }

  function finishedPayload(): { result: FinishedResult; abortReason: string | null } | undefined {
    return emitted.find((e) => e.channel === 'game:finished')?.payload as { result: FinishedResult; abortReason: string | null } | undefined;
  }

  it('楽曲を取り込み、スクリプト入力で最後までプレイし、正しいキーで登録される', async () => {
    const { chart } = await importAndSelect(2);
    const prepared = await controller.prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.notes).toEqual(NOTES);
    expect(prepared.audioToken).toBe('tok');
    expect(tokens.get('tok')).toContain(library.rootDir);
    expect(prepared.rankingKey).toBe(`neon-hit:song:int-track:${chart.audioSha256}:v1:L2`);

    const started = await controller.start(prepared.sessionId);
    expect(started).toEqual({ ok: true });
    // カウントダウン終了直後に音声開始を報告
    clock += JUDGE.countdownMs + 5;
    controller.audioStarted(prepared.sessionId, 5);
    const songStart = clock - 5;
    // 各音符を PERFECT / GOOD で押す
    const deltas = [0, 50, -100, 120, 10];
    for (let i = 0; i < NOTES.length; i++) {
      clock = songStart + NOTES[i]! + deltas[i]!;
      controller.audioPosition(prepared.sessionId, clock - songStart);
      devices.virtual.inject('pressed');
      clock += 20;
      devices.virtual.inject('released');
    }
    // 終了まで進める（位置報告を続ける）
    const end = songStart + Math.max(chart.durationMs, NOTES[NOTES.length - 1]! + JUDGE.badMs) + 1000;
    while (clock < end) {
      clock += 100;
      controller.audioPosition(prepared.sessionId, clock - songStart);
      await sleep(5);
    }
    await sleep(30);
    const payload = finishedPayload();
    expect(payload).toBeDefined();
    expect(payload!.abortReason).toBeNull();
    expect(payload!.result.counts).toEqual({ PERFECT: 3, GOOD: 2, BAD: 0, MISS: 0 });
    expect(payload!.result.score).toBe(400);
    expect(payload!.result.rankingEligible).toBe(true);
    expect(payload!.result.provisionalRank).toBe(1);

    const reg = await controller.registerName(prepared.sessionId, '統合テスト');
    expect(reg).toEqual({ ok: true, rank: 1 });
    const file = JSON.parse(await readFile(path.join(root, 'rankings.json'), 'utf8')) as { rankings: Record<string, { name: string; score: number }[]> };
    expect(Object.keys(file.rankings)).toEqual([prepared.rankingKey]);
    expect(file.rankings[prepared.rankingKey]![0]).toMatchObject({ name: '統合テスト', score: 400 });
    // 二重登録は拒否
    expect((await controller.registerName(prepared.sessionId, 'x')).ok).toBe(false);
  });

  it('音声開始に失敗するとセッションは中断され、ランキングに登録できない', async () => {
    await importAndSelect(1);
    const prepared = await controller.prepare();
    if (!prepared.ok) throw new Error(prepared.reasons.join());
    await controller.start(prepared.sessionId);
    clock += JUDGE.countdownMs + SYNC.startHandshakeTimeoutMs + 10;
    await sleep(40);
    const payload = finishedPayload();
    expect(payload?.abortReason).toBe('audio-start-failed');
    expect(payload?.result.rankingEligible).toBe(false);
    expect((await controller.registerName(prepared.sessionId, 'x')).ok).toBe(false);
    expect(await rankings.keys()).toEqual([]);

    // renderer からの再生失敗通知でも中断する
    const p2 = await controller.prepare();
    if (!p2.ok) throw new Error(p2.reasons.join());
    await controller.start(p2.sessionId);
    controller.audioFailed(p2.sessionId, 'デコード失敗');
    await sleep(20);
    const payload2 = emitted.filter((e) => e.channel === 'game:finished').pop()?.payload as { abortReason: string };
    expect(payload2.abortReason).toBe('audio-error');
  });

  it('同じ曲の重複と、同一ID・異なる内容を安全に処理する', async () => {
    const { pkg } = await importAndSelect(1);
    expect((await importer.importFrom(pkg)).status).toBe('duplicate');
    const pkg2 = path.join(root, 'pkg2');
    await writeTestPackage(pkg2, { trackId: 'int-track', durationSec: 7, title: '別内容' });
    const c = await importer.importFrom(pkg2);
    expect(c.status).toBe('conflict');
    if (c.status !== 'conflict') return;
    // プレイ中は置換できない
    const prepared = await controller.prepare();
    if (!prepared.ok) throw new Error(prepared.reasons.join());
    await controller.start(prepared.sessionId);
    const busy = await importer.resolveConflict(c.pendingId, 'replace', (t, s) => controller.isTrackInUse(t, s));
    expect(busy.status).toBe('rejected');
    controller.abort('user');
    const c2 = await importer.importFrom(pkg2);
    if (c2.status !== 'conflict') throw new Error('expected conflict');
    const r = await importer.resolveConflict(c2.pendingId, 'new-id', (t, s) => controller.isTrackInUse(t, s));
    expect(r.status).toBe('imported');
    expect((await library.list()).map((e) => e.trackId).sort()).toEqual(['int-track', 'int-track-2']);
  });

  it('固定譜面モードは音声なしでも同じエンジンで最後まで進む', async () => {
    await settings.update({ mode: 'fixed', deviceId: 'virtual-keyboard' });
    const prepared = await controller.prepare();
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.audioToken).toBeNull();
    expect(prepared.rankingKey).toBe('neon-hit:fixed:default-v1');
    await controller.start(prepared.sessionId);
    clock += JUDGE.countdownMs;
    controller.audioStarted(prepared.sessionId, 0);
    const songStart = clock;
    const end = songStart + prepared.durationMs + JUDGE.badMs + 1000;
    while (clock < end) {
      clock += 200;
      controller.audioPosition(prepared.sessionId, clock - songStart);
      await sleep(3);
    }
    await sleep(30);
    const payload = finishedPayload();
    expect(payload?.abortReason).toBeNull();
    expect(payload?.result.counts.MISS).toBe(prepared.notes.length);
  });

  it('設定が不正なら開始できず理由を返す', async () => {
    await settings.update({ mode: 'song', deviceId: 'serial-button-1' });
    const r = await controller.prepare();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons.join()).toContain('楽曲が選択されていません');
    expect(r.reasons.join()).toContain('実物ボタンは未接続');
  });
});
