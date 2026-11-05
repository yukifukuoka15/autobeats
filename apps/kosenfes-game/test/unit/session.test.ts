import { JUDGE, SYNC } from '@autobeats/chart-format';
import { describe, expect, it } from 'vitest';
import { FINISH_GRACE_MS, GameSession, type LedColor } from '../../src/main/game/session';
import type { SessionEvent } from '../../src/shared/types';

function makeSession(notes: number[], opts: { requiresAudio?: boolean; inputOffsetMs?: number; durationMs?: number } = {}) {
  let t = 1000;
  const events: SessionEvent[] = [];
  const leds: { color: LedColor; durationMs: number }[] = [];
  const s = new GameSession({ now: () => t, onEvent: (e) => events.push(e), setLed: (color, durationMs) => leds.push({ color, durationMs }) });
  s.start({ sessionId: 'S1', notes, durationMs: opts.durationMs ?? 10000, inputOffsetMs: opts.inputOffsetMs ?? 0, requiresAudio: opts.requiresAudio ?? false, rankingEligible: true });
  const clock = {
    set: (v: number) => (t = v),
    get: () => t,
    /** 楽曲時刻へ移動（songStart = 1000 + 3000 = 4000） */
    song: (songMs: number) => (t = 4000 + songMs),
  };
  let seq = 0;
  const press = (songMs: number, id = `e${++seq}`) => {
    clock.song(songMs);
    s.press({ sessionId: 'S1', eventId: id, seq, receivedAtMs: t });
  };
  const release = (songMs: number) => {
    clock.song(songMs);
    s.release({ sessionId: 'S1', eventId: `r${++seq}`, seq });
  };
  const play = () => {
    clock.set(4000);
    s.tick();
    expect(s.state).toBe('playing');
  };
  return { s, events, leds, clock, press, release, play, seqRef: () => seq };
}

describe('GameSession', () => {
  it('カウントダウン後に playing になり、判定幅どおりに判定する', () => {
    const { s, press, release, play } = makeSession([1000, 2000, 3000, 4000, 5000]);
    expect(s.state).toBe('countdown');
    play();
    press(1080); // PERFECT 境界
    release(1100);
    press(2161); // BAD（161）
    release(2200);
    press(3000 - 160); // GOOD 境界 EARLY
    release(2900);
    press(4221); // 範囲外 → 空押し（4000 の音符は猶予超過で MISS）
    release(4300);
    expect(s.counts).toEqual({ PERFECT: 1, GOOD: 1, BAD: 1, MISS: 1 });
    expect(s.emptyPresses).toBe(1);
    expect(s.score).toBe(100 + 10 + 50);
  });

  it('得点・コンボ規則: PERFECT/GOOD で増加、BAD/MISS/空押しで 0', () => {
    const { s, press, release, play } = makeSession([1000, 2000, 3000, 4000, 5000, 6000]);
    play();
    press(1000);
    release(1050);
    press(2050);
    release(2100);
    expect(s.combo).toBe(2);
    press(3200); // BAD
    release(3250);
    expect(s.combo).toBe(0);
    press(4000);
    release(4050);
    expect(s.combo).toBe(1);
    press(4500); // 空押し
    release(4550);
    expect(s.combo).toBe(0);
    expect(s.maxCombo).toBe(2);
  });

  it('最も近い未判定音符だけを判定し、同距離は早い方', () => {
    const { s, press, release, play, events } = makeSession([1000, 1400]);
    play();
    press(1200);
    release(1250);
    const j = events.filter((e) => e.kind === 'judgement');
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ noteIndex: 0, judgement: 'BAD' });
    press(1400);
    release(1450);
    expect(s.counts.PERFECT).toBe(1);
  });

  it('EARLY/LATE: PERFECT では付かない', () => {
    const { press, release, play, events } = makeSession([1000, 2000, 3000]);
    play();
    press(1050);
    release(1100);
    press(2100);
    release(2150);
    press(2850);
    release(2900);
    const j = events.filter((e): e is Extract<SessionEvent, { kind: 'judgement' }> => e.kind === 'judgement');
    expect(j.map((e) => e.earlyLate)).toEqual([null, 'LATE', 'EARLY']);
  });

  it('押しっぱなし・同一イベントID・古いシーケンス・別セッションを二重判定しない', () => {
    const { s, clock, play } = makeSession([1000, 2000]);
    play();
    clock.song(1000);
    s.press({ sessionId: 'S1', eventId: 'a', seq: 1, receivedAtMs: clock.get() });
    s.press({ sessionId: 'S1', eventId: 'a', seq: 1, receivedAtMs: clock.get() }); // 同一ID
    clock.song(2000);
    s.press({ sessionId: 'S1', eventId: 'b', seq: 2, receivedAtMs: clock.get() }); // 解放前 → 無視
    expect(s.counts.PERFECT).toBe(1);
    s.release({ sessionId: 'S1', eventId: 'c', seq: 3 });
    s.press({ sessionId: 'S1', eventId: 'd', seq: 2, receivedAtMs: clock.get() }); // 古い seq
    expect(s.counts.PERFECT).toBe(1);
    s.press({ sessionId: 'OLD', eventId: 'e', seq: 4, receivedAtMs: clock.get() }); // 別セッション
    expect(s.counts.PERFECT).toBe(1);
    s.press({ sessionId: 'S1', eventId: 'f', seq: 4, receivedAtMs: clock.get() });
    expect(s.counts.PERFECT).toBe(2);
  });

  it('判定猶予を過ぎた音符は MISS になり、終了規則で finished になる', () => {
    const { s, clock, play } = makeSession([1000, 2000], { durationMs: 1500 });
    play();
    clock.song(1220);
    s.tick();
    expect(s.counts.MISS).toBe(0);
    clock.song(1221);
    s.tick();
    expect(s.counts.MISS).toBe(1);
    // 終了 = max(1500, 2000 + 220) + 猶予
    clock.song(2000 + JUDGE.badMs + FINISH_GRACE_MS - 1);
    s.tick();
    expect(s.state).toBe('playing');
    clock.song(2000 + JUDGE.badMs + FINISH_GRACE_MS);
    s.tick();
    expect(s.state).toBe('finished');
    expect(s.counts.MISS).toBe(2);
    expect(s.rankingEligible).toBe(true);
  });

  it('入力遅延補正を押下時刻から引く', () => {
    const { s, press, release, play } = makeSession([1000], { inputOffsetMs: 100 });
    play();
    press(1100); // 補正後 1000 → PERFECT
    release(1150);
    expect(s.counts.PERFECT).toBe(1);
    const neg = makeSession([1000], { inputOffsetMs: -200 });
    neg.play();
    neg.press(1000); // 補正後 1200 → BAD
    expect(neg.s.counts.BAD).toBe(1);
  });

  it('音声ハンドシェイクが来なければ中断し、ランキング対象外', () => {
    const { s, clock } = makeSession([1000], { requiresAudio: true });
    clock.set(4000 + SYNC.startHandshakeTimeoutMs - 1);
    s.tick();
    expect(s.state).toBe('countdown');
    clock.set(4000 + SYNC.startHandshakeTimeoutMs);
    s.tick();
    expect(s.state).toBe('aborted');
    expect(s.abortReason).toBe('audio-start-failed');
    expect(s.rankingEligible).toBe(false);
  });

  it('ハンドシェイクで楽曲時刻 0 が決まり、開始遅延が大きければ中断', () => {
    const { s, clock } = makeSession([1000], { requiresAudio: true });
    clock.set(4050);
    s.audioStarted({ sessionId: 'S1', latencyMs: 30 }); // songStart = 4020
    expect(s.state).toBe('playing');
    clock.set(5020);
    s.press({ sessionId: 'S1', eventId: 'p', seq: 1, receivedAtMs: 5020 });
    expect(s.counts.PERFECT).toBe(1);

    const late = makeSession([1000], { requiresAudio: true });
    late.clock.set(4000 + SYNC.maxStartLatencyMs + 1);
    late.s.audioStarted({ sessionId: 'S1', latencyMs: 0 });
    expect(late.s.state).toBe('aborted');
    expect(late.s.abortReason).toBe('audio-start-failed');
  });

  it('音声位置のずれが連続で許容値を超えると中断、途絶でも中断', () => {
    const { s, clock } = makeSession([1000, 20000], { requiresAudio: true, durationMs: 30000 });
    clock.set(4000);
    s.audioStarted({ sessionId: 'S1', latencyMs: 0 });
    for (let i = 0; i < SYNC.driftAbortCount - 1; i++) {
      clock.song(1000 + i * 100);
      s.audioPosition({ sessionId: 'S1', songTimeMs: 1000 + i * 100 + SYNC.maxDriftMs + 1 });
    }
    expect(s.state).toBe('playing');
    clock.song(2000);
    s.audioPosition({ sessionId: 'S1', songTimeMs: 2000 }); // 正常報告でリセット
    for (let i = 0; i < SYNC.driftAbortCount; i++) {
      clock.song(3000 + i * 100);
      s.audioPosition({ sessionId: 'S1', songTimeMs: 3000 + i * 100 - SYNC.maxDriftMs - 1 });
    }
    expect(s.state).toBe('aborted');
    expect(s.abortReason).toBe('audio-desync');

    const t2 = makeSession([1000, 20000], { requiresAudio: true, durationMs: 30000 });
    t2.clock.set(4000);
    t2.s.audioStarted({ sessionId: 'S1', latencyMs: 0 });
    t2.clock.song(SYNC.driftReportTimeoutMs + 1);
    t2.s.tick();
    expect(t2.s.state).toBe('aborted');
    expect(t2.s.abortReason).toBe('audio-desync');
  });

  it('LED フィードバック色と時間', () => {
    const { leds, press, release, play } = makeSession([1000, 2000, 3000, 4000]);
    play();
    press(1000);
    release(1050);
    press(2100);
    release(2150);
    press(3200);
    release(3250);
    press(3600);
    release(3650);
    expect(leds.slice(1)).toEqual([
      { color: 'white', durationMs: 100 },
      { color: 'yellow', durationMs: 100 },
      { color: 'orange', durationMs: 150 },
      { color: 'purple', durationMs: 150 },
    ]);
  });

  it('スナップショットは renderer 向けに状態を要約する', () => {
    const { s, press, release, play } = makeSession([1000, 2000]);
    play();
    press(1000);
    release(1050);
    const snap = s.snapshot();
    expect(snap.noteStates).toEqual([1, 0]);
    expect(snap.score).toBe(100);
    expect(snap.state).toBe('playing');
    expect(snap.lastJudgement?.judgement).toBe('PERFECT');
  });
});
