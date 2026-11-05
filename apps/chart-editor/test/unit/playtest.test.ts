import { JUDGE, type ChartNote } from '@autobeats/chart-format';
import { describe, expect, it } from 'vitest';
import { PLAYTEST_KEYS, PlaytestEngine, playtestResultLabel } from '../../src/renderer/src/playtest/engine';

const n = (id: string, hitAtMs: number): ChartNote => ({ id, hitAtMs, source: 'generated' });
const levels = {
  '1': { notes: [n('a1', 1000), n('a2', 3000)] },
  '2': { notes: [n('b1', 1200), n('b2', 5000)] },
  '3': { notes: [n('c1', 2000)] },
  '4': { notes: [n('d1', 500), n('d2', 2500)] },
};

describe('PlaytestEngine', () => {
  it('キー割り当ては L1=Q, L2=W, L3=O, L4=P', () => {
    expect(PLAYTEST_KEYS).toEqual({ '1': 'q', '2': 'w', '3': 'o', '4': 'p' });
  });

  it('レーンごとに最も近い未判定音符を判定し、スコア・コンボを合算する', () => {
    const e = new PlaytestEngine(levels, { startMs: 0, durationMs: 10000, inputOffsetMs: 0 });
    expect(e.totalNotes).toBe(7);
    expect(e.press('1', 1050)?.kind).toBe('PERFECT');
    e.release('1');
    expect(e.press('2', 1300)).toMatchObject({ kind: 'GOOD', earlyLate: 'LATE' });
    e.release('2');
    expect(e.press('4', 300)).toMatchObject({ kind: 'BAD', earlyLate: 'EARLY' });
    e.release('4');
    expect(e.score).toBe(100 + 50 + 10);
    expect(e.combo).toBe(0); // BAD でコンボが切れる
    expect(e.maxCombo).toBe(2);
    // 別レーンの音符は判定対象にならない（L3 の 2000ms を L1 で押しても空押し）
    expect(e.press('1', 2000)?.kind).toBe('EMPTY');
    e.release('1');
    expect(e.lanes['3'].notes[0]!.judgement).toBeNull();
    expect(playtestResultLabel('GOOD', 'LATE')).toBe('GOOD LATE');
    expect(playtestResultLabel('PERFECT', null)).toBe('PERFECT');
    expect(playtestResultLabel('EMPTY', null)).toBe('空押し');
  });

  it('押しっぱなしは次の押下を受け付けず、解放で復帰する', () => {
    const e = new PlaytestEngine(levels, { startMs: 0, durationMs: 10000, inputOffsetMs: 0 });
    expect(e.press('1', 1000)?.kind).toBe('PERFECT');
    expect(e.press('1', 3000)).toBeNull();
    e.release('1');
    expect(e.press('1', 3000)?.kind).toBe('PERFECT');
  });

  it('判定猶予を過ぎた音符は MISS になり、入力遅延補正が適用される', () => {
    const e = new PlaytestEngine(levels, { startMs: 0, durationMs: 10000, inputOffsetMs: 50 });
    e.tick(1000 + JUDGE.badMs);
    expect(e.lanes['1'].notes[0]!.judgement).toBeNull();
    e.tick(1000 + JUDGE.badMs + 1);
    expect(e.lanes['1'].notes[0]!.judgement).toBe('MISS');
    expect(e.lanes['4'].notes[0]!.judgement).toBe('MISS'); // 500ms も過ぎている
    expect(e.totals().MISS).toBe(2);
    // 補正 +50: 受信 3050 → 補正後 3000 → PERFECT
    expect(e.press('1', 3050)?.kind).toBe('PERFECT');
    expect(e.lanes['1'].notes[1]!.deltaMs).toBe(0);
  });

  it('開始位置より前の音符は対象外で、終了時刻は最後の音符の猶予後', () => {
    const e = new PlaytestEngine(levels, { startMs: 1500, durationMs: 4000, inputOffsetMs: 0 });
    expect(e.lanes['1'].notes.map((x) => x.hitAtMs)).toEqual([3000]);
    expect(e.lanes['2'].notes.map((x) => x.hitAtMs)).toEqual([]);
    expect(e.totalNotes).toBe(3); // 3000, 2000, 2500
    expect(e.endAtMs).toBe(4000 + 600);
    const late = new PlaytestEngine({ ...levels, '2': { notes: [n('b', 3900)] } }, { startMs: 0, durationMs: 4000, inputOffsetMs: 0 });
    expect(late.endAtMs).toBe(3900 + JUDGE.badMs + 600);
    expect(late.isFinished(4000)).toBe(false);
    expect(late.isFinished(4720)).toBe(true);
  });
});
