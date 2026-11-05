import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCRUB, grainDurationFor, scrubStepFor } from '../../src/renderer/src/scrub/constants';
import { GrainPlayer, planGrain, sliceGrain, type GrainAudio } from '../../src/renderer/src/scrub/grain';
import { ScrubController, type ScrubTransport } from '../../src/renderer/src/scrub/scrubController';

interface Grain {
  newTimeMs: number;
  direction: 1 | -1;
  lengthMs: number;
}

function fakeTransport(durationMs = 60000, start = 10000) {
  const state = { playing: false, hasAudio: true, ms: start, grains: [] as Grain[], stops: 0, seeks: [] as number[] };
  const t: ScrubTransport = {
    isPlaying: () => state.playing,
    hasAudio: () => state.hasAudio,
    durationMs: () => durationMs,
    currentMs: () => state.ms,
    seek: (ms) => {
      state.ms = ms;
      state.seeks.push(ms);
    },
    playGrain: (newTimeMs, direction, lengthMs) => state.grains.push({ newTimeMs, direction, lengthMs }),
    stopGrains: () => state.stops++,
  };
  return { t, state };
}

const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
  clearInterval: (id: number) => clearInterval(id),
};

const press = (key: 'ArrowLeft' | 'ArrowRight', shift = false, option = false) => ({ key, shift, option, repeat: false });

describe('ScrubController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('停止中の右矢印短押しで 20ms 進み、左矢印で 20ms 戻る', () => {
    const { t, state } = fakeTransport();
    const c = new ScrubController(t, timers);
    expect(c.keyDown(press('ArrowRight'))).toBe(true);
    c.keyUp('ArrowRight');
    expect(state.ms).toBe(10020);
    c.keyDown(press('ArrowLeft'));
    c.keyUp('ArrowLeft');
    expect(state.ms).toBe(10000);
    expect(state.grains.map((g) => g.direction)).toEqual([1, -1]);
  });

  it('修飾キーで移動量が変わる（Shift 100 / Option 1 / Shift+Option 500）', () => {
    expect(scrubStepFor({ shift: false, option: false })).toBe(20);
    expect(scrubStepFor({ shift: true, option: false })).toBe(100);
    expect(scrubStepFor({ shift: false, option: true })).toBe(1);
    expect(scrubStepFor({ shift: true, option: true })).toBe(500);
    const { t, state } = fakeTransport();
    const c = new ScrubController(t, timers);
    const run = (key: 'ArrowLeft' | 'ArrowRight', shift: boolean, option: boolean) => {
      c.keyDown(press(key, shift, option));
      c.keyUp(key);
      return state.ms;
    };
    expect(run('ArrowRight', true, false)).toBe(10100);
    expect(run('ArrowLeft', true, false)).toBe(10000);
    expect(run('ArrowRight', false, true)).toBe(10001);
    expect(run('ArrowLeft', false, true)).toBe(10000);
    expect(run('ArrowRight', true, true)).toBe(10500);
    expect(run('ArrowLeft', true, true)).toBe(10000);
  });

  it('0ms より前・曲の長さより後へは移動しない', () => {
    const a = fakeTransport(60000, 5);
    const ca = new ScrubController(a.t, timers);
    ca.keyDown(press('ArrowLeft'));
    ca.keyUp('ArrowLeft');
    expect(a.state.ms).toBe(0);
    ca.keyDown(press('ArrowLeft'));
    ca.keyUp('ArrowLeft');
    expect(a.state.ms).toBe(0);
    const b = fakeTransport(60000, 59990);
    const cb = new ScrubController(b.t, timers);
    cb.keyDown(press('ArrowRight'));
    cb.keyUp('ArrowRight');
    expect(b.state.ms).toBe(60000);
  });

  it('300ms 未満は短押し、300ms 以上で長押しになり指定間隔で連続移動し、keyup で止まる', () => {
    const { t, state } = fakeTransport();
    const c = new ScrubController(t, timers);
    c.keyDown(press('ArrowRight'));
    vi.advanceTimersByTime(SCRUB.holdDelayMs - 1);
    expect(c.state.holding).toBe(false);
    c.keyUp('ArrowRight');
    expect(state.ms).toBe(10020); // 短押し: 1 ステップだけ
    expect(c.state.active).toBe(false);
    // 長押し
    c.keyDown(press('ArrowRight'));
    vi.advanceTimersByTime(SCRUB.holdDelayMs);
    expect(c.state.holding).toBe(true);
    vi.advanceTimersByTime(SCRUB.repeatIntervalMs * 5);
    expect(state.ms).toBe(10040 + SCRUB.repeatStepMs * 5);
    const grainsBefore = state.grains.length;
    c.keyUp('ArrowRight');
    expect(c.state.holding).toBe(false);
    expect(state.stops).toBeGreaterThan(0);
    vi.advanceTimersByTime(1000);
    expect(state.ms).toBe(10040 + SCRUB.repeatStepMs * 5); // 離した後は動かない
    expect(state.grains.length).toBe(grainsBefore);
  });

  it('OS のキーリピート（event.repeat）は移動回数に使わない', () => {
    const { t, state } = fakeTransport();
    const c = new ScrubController(t, timers);
    c.keyDown(press('ArrowRight'));
    for (let i = 0; i < 10; i++) c.keyDown({ ...press('ArrowRight'), repeat: true });
    vi.advanceTimersByTime(100);
    expect(state.ms).toBe(10020);
    c.keyUp('ArrowRight');
  });

  it('cancel（blur・visibilitychange・アンマウント相当）で長押しが止まりタイマーが破棄される', () => {
    const { t, state } = fakeTransport();
    const c = new ScrubController(t, timers);
    c.keyDown(press('ArrowRight'));
    vi.advanceTimersByTime(SCRUB.holdDelayMs + SCRUB.repeatIntervalMs * 2);
    const at = state.ms;
    c.cancel();
    expect(c.state.active).toBe(false);
    expect(c.state.holding).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(state.ms).toBe(at);
    expect(vi.getTimerCount()).toBe(0);
    c.dispose();
    // 同じ目的で dispose 後も keyup は安全
    expect(c.keyUp('ArrowRight')).toBe(false);
  });

  it('通常再生中・音声未読込ではスクラブを開始しない', () => {
    const { t, state } = fakeTransport();
    state.playing = true;
    const c = new ScrubController(t, timers);
    expect(c.keyDown(press('ArrowRight'))).toBe(false);
    expect(state.ms).toBe(10000);
    state.playing = false;
    state.hasAudio = false;
    expect(c.keyDown(press('ArrowRight'))).toBe(false);
  });

  it('長押し中に再生が始まったら連続移動を止める', () => {
    const { t, state } = fakeTransport();
    const c = new ScrubController(t, timers);
    c.keyDown(press('ArrowRight'));
    vi.advanceTimersByTime(SCRUB.holdDelayMs + SCRUB.repeatIntervalMs);
    state.playing = true;
    const at = state.ms;
    vi.advanceTimersByTime(SCRUB.repeatIntervalMs * 3);
    expect(state.ms).toBe(at);
    expect(c.state.holding).toBe(false);
  });

  it('左右同時押しは後から押した方向を優先し、離されたら残った方へ戻る', () => {
    const { t, state } = fakeTransport();
    const c = new ScrubController(t, timers);
    c.keyDown(press('ArrowRight'));
    vi.advanceTimersByTime(SCRUB.holdDelayMs + SCRUB.repeatIntervalMs);
    const afterRight = state.ms;
    expect(afterRight).toBeGreaterThan(10000);
    c.keyDown(press('ArrowLeft'));
    expect(c.state.direction).toBe(-1);
    vi.advanceTimersByTime(SCRUB.holdDelayMs + SCRUB.repeatIntervalMs * 3);
    expect(state.ms).toBeLessThan(afterRight);
    const afterLeft = state.ms;
    c.keyUp('ArrowLeft');
    expect(c.state.direction).toBe(1);
    expect(c.state.active).toBe(true);
    vi.advanceTimersByTime(SCRUB.repeatIntervalMs * 3);
    expect(state.ms).toBeGreaterThan(afterLeft);
    c.keyUp('ArrowRight');
    expect(c.state.active).toBe(false);
    vi.advanceTimersByTime(500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('曲の境界では連続処理を止め、同じ音声片を鳴らし続けない', () => {
    const { t, state } = fakeTransport(60000, 59970);
    const c = new ScrubController(t, timers);
    c.keyDown(press('ArrowRight'));
    vi.advanceTimersByTime(SCRUB.holdDelayMs + SCRUB.repeatIntervalMs * 10);
    expect(state.ms).toBe(60000);
    expect(c.state.holding).toBe(false);
    const grains = state.grains.length;
    vi.advanceTimersByTime(1000);
    expect(state.grains.length).toBe(grains);
    expect(grains).toBeLessThanOrEqual(3);
    c.keyUp('ArrowRight');
  });

  it('音声片の長さは 40～100ms（移動量に応じる）', () => {
    expect(grainDurationFor(20)).toBe(40);
    expect(grainDurationFor(1)).toBe(40);
    expect(grainDurationFor(100)).toBe(100);
    expect(grainDurationFor(500)).toBe(100);
    const { t, state } = fakeTransport();
    const c = new ScrubController(t, timers);
    c.keyDown(press('ArrowRight', true, false));
    c.keyUp('ArrowRight');
    expect(state.grains[0]).toEqual({ newTimeMs: 10100, direction: 1, lengthMs: 100 });
  });
});

describe('グレイン（音声片）', () => {
  it('移動先の正しい時刻から切り出し、逆方向は逆順になり、両端にフェードが掛かる', () => {
    const sr = 1000;
    const pcm = new Float32Array(1000).map((_, i) => i); // 1 秒、値 = サンプル番号
    const plan = planGrain(500, 1, 40, 1000)!;
    expect(plan).toEqual({ startMs: 500, lengthMs: 40, reverse: false });
    const fwd = sliceGrain(pcm, sr, plan, 5);
    expect(fwd.length).toBe(40);
    expect(fwd[20]).toBe(520); // 中央はそのまま
    expect(fwd[0]).toBeCloseTo(500 * (1 / 6)); // 先頭フェード
    expect(fwd[39]).toBeCloseTo(539 * (1 / 6)); // 末尾フェード
    const rev = sliceGrain(pcm, sr, planGrain(500, -1, 40, 1000)!, 5);
    expect(rev[20]).toBe(519);
    expect(rev[5]).toBe(534);
    // 範囲外は曲内へクランプ
    expect(planGrain(990, 1, 40, 1000)).toEqual({ startMs: 960, lengthMs: 40, reverse: false });
    expect(planGrain(-5, -1, 40, 1000)).toEqual({ startMs: 0, lengthMs: 40, reverse: true });
    expect(planGrain(10, 1, 40, 0)).toBeNull();
  });

  it('GrainPlayer は同時ノード数を制限し、stopAll で全停止し、ミュートや音声未読込では鳴らさない', () => {
    vi.useFakeTimers();
    const played: { gain: number; frames: number; stopped: boolean }[] = [];
    const audio: GrainAudio = {
      play: (channels, _sr, gain) => {
        const rec = { gain, frames: channels[0]!.length, stopped: false };
        played.push(rec);
        return { stop: () => (rec.stopped = true) };
      },
    };
    const player = new GrainPlayer(audio, 2);
    const source = { sampleRate: 1000, durationMs: 1000, channels: [new Float32Array(1000).fill(0.5)] };
    expect(player.play(null, 100, 1, 40, 0.8)).toBeNull();
    expect(player.play(source, 100, 1, 40, 0)).toBeNull(); // ミュート
    player.play(source, 100, 1, 40, 0.8);
    player.play(source, 120, 1, 40, 0.8);
    player.play(source, 140, 1, 40, 0.8);
    expect(played.length).toBe(3);
    expect(played[0]!.stopped).toBe(true); // 上限超過で最古を停止
    expect(player.activeCount).toBe(2);
    expect(played[1]!.gain).toBe(0.8);
    expect(played[1]!.frames).toBe(40);
    player.stopAll();
    expect(played.every((p) => p.stopped)).toBe(true);
    expect(player.activeCount).toBe(0);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
  });
});
