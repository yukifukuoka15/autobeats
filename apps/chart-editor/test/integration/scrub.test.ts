/**
 * スクラブの統合: 実際の WAV フィクスチャを読み込み、ScrubController → GrainPlayer の経路で
 * 再生ヘッド・音声片の位置と内容が一致することを確認する（AudioContext は使わず偽出力へ）。
 */
import { decodeWav } from '@autobeats/audio-analysis';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCRUB } from '../../src/renderer/src/scrub/constants';
import { GrainPlayer, type GrainAudio } from '../../src/renderer/src/scrub/grain';
import { ScrubController, type ScrubTransport } from '../../src/renderer/src/scrub/scrubController';

const FIXTURE = path.resolve(__dirname, '../../../../fixtures/generated/song.wav');

describe('キーボードスクラブ（統合）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.skipIf(!existsSync(FIXTURE))('短押し・長押しで再生ヘッドと音声片の位置が一致し、キーを離すと止まり、プロジェクト切替で解除される', async () => {
    const wav = decodeWav(new Uint8Array(await readFile(FIXTURE)));
    const durationMs = Math.round((wav.channels[0]!.length / wav.sampleRate) * 1000);
    const played: { samples: Float32Array; stopped: boolean }[] = [];
    const audio: GrainAudio = {
      play: (channels) => {
        const rec = { samples: channels[0]!, stopped: false };
        played.push(rec);
        return { stop: () => (rec.stopped = true) };
      },
    };
    const player = new GrainPlayer(audio);
    const source = { sampleRate: wav.sampleRate, durationMs, channels: wav.channels };
    let ms = 20000;
    let playing = false;
    let volume = 0.9;
    const transport: ScrubTransport = {
      isPlaying: () => playing,
      hasAudio: () => true,
      durationMs: () => durationMs,
      currentMs: () => ms,
      seek: (t) => (ms = t),
      playGrain: (t, dir, len) => player.play(source, t, dir, len, volume),
      stopGrains: () => player.stopAll(),
    };
    const timers = {
      setTimeout: (fn: () => void, d: number) => setTimeout(fn, d) as unknown as number,
      clearTimeout: (id: number) => clearTimeout(id),
      setInterval: (fn: () => void, d: number) => setInterval(fn, d) as unknown as number,
      clearInterval: (id: number) => clearInterval(id),
    };
    const c = new ScrubController(transport, timers);

    // 右短押し: 20020ms からの 40ms が通常方向で鳴る
    c.keyDown({ key: 'ArrowRight', shift: false, option: false, repeat: false });
    c.keyUp('ArrowRight');
    expect(ms).toBe(20020);
    const g1 = played[0]!.samples;
    const expectedLen = Math.round((SCRUB.grainMinDurationMs / 1000) * wav.sampleRate);
    expect(g1.length).toBe(expectedLen);
    const startSample = Math.round((20020 / 1000) * wav.sampleRate);
    const mid = Math.floor(expectedLen / 2);
    expect(g1[mid]).toBeCloseTo(wav.channels[0]![startSample + mid]!, 5); // 中央はフェードなし
    // 左短押し: 20000ms からの 40ms が逆順で鳴る
    c.keyDown({ key: 'ArrowLeft', shift: false, option: false, repeat: false });
    c.keyUp('ArrowLeft');
    expect(ms).toBe(20000);
    const g2 = played[1]!.samples;
    const s2 = Math.round((20000 / 1000) * wav.sampleRate);
    expect(g2[mid]).toBeCloseTo(wav.channels[0]![s2 + expectedLen - 1 - mid]!, 5);
    // 長押し右: 300ms 後から 60ms ごとに 20ms。音は移動のたびに鳴り、同時ノードは上限以下
    c.keyDown({ key: 'ArrowRight', shift: false, option: false, repeat: false });
    vi.advanceTimersByTime(SCRUB.holdDelayMs + SCRUB.repeatIntervalMs * 10);
    expect(ms).toBe(20020 + SCRUB.repeatStepMs * 10);
    expect(player.activeCount).toBeLessThanOrEqual(SCRUB.maxActiveGrains);
    const count = played.length;
    c.keyUp('ArrowRight');
    expect(player.activeCount).toBe(0); // 離すとまだ鳴っている音声片は停止（自然終了したものは既に解放済み）
    vi.advanceTimersByTime(1000);
    expect(played.length).toBe(count);
    // 長押し左: 逆方向
    c.keyDown({ key: 'ArrowLeft', shift: false, option: false, repeat: false });
    vi.advanceTimersByTime(SCRUB.holdDelayMs + SCRUB.repeatIntervalMs * 3);
    expect(c.state.direction).toBe(-1);
    expect(c.state.holding).toBe(true);
    c.keyUp('ArrowLeft');
    const final = ms;
    vi.advanceTimersByTime(500);
    expect(ms).toBe(final);
    // ミュート（原曲音量 0）では鳴らさず再生ヘッドだけ動く
    volume = 0;
    const before = played.length;
    c.keyDown({ key: 'ArrowRight', shift: false, option: false, repeat: false });
    c.keyUp('ArrowRight');
    expect(ms).toBe(final + 20);
    expect(played.length).toBe(before);
    volume = 0.9;
    // ループ設定と無関係に曲全体を移動できる（ループ範囲へ戻さない）: 先頭付近へ
    ms = 10;
    c.keyDown({ key: 'ArrowLeft', shift: true, option: false, repeat: false });
    c.keyUp('ArrowLeft');
    expect(ms).toBe(0);
    // プロジェクト切替相当の cancel で状態が解除される
    c.keyDown({ key: 'ArrowRight', shift: false, option: false, repeat: false });
    vi.advanceTimersByTime(SCRUB.holdDelayMs + SCRUB.repeatIntervalMs);
    expect(c.state.holding).toBe(true);
    c.cancel();
    expect(c.state.active).toBe(false);
    expect(player.activeCount).toBe(0);
    // 通常再生中は開始しない
    playing = true;
    expect(c.keyDown({ key: 'ArrowRight', shift: false, option: false, repeat: false })).toBe(false);
  });
});
