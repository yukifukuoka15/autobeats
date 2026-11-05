import { describe, expect, it } from 'vitest';
import { applyInputOffset, breaksCombo, clampInputOffset, classifyDelta, earlyLateFor, findJudgeTarget, scoreFor } from '../src';

describe('judge', () => {
  it('判定幅', () => {
    expect(classifyDelta(0)).toBe('PERFECT');
    expect(classifyDelta(80)).toBe('PERFECT');
    expect(classifyDelta(-81)).toBe('GOOD');
    expect(classifyDelta(160)).toBe('GOOD');
    expect(classifyDelta(161)).toBe('BAD');
    expect(classifyDelta(220)).toBe('BAD');
    expect(classifyDelta(221)).toBeNull();
  });
  it('得点とコンボ', () => {
    expect(scoreFor('PERFECT')).toBe(100);
    expect(scoreFor('GOOD')).toBe(50);
    expect(scoreFor('BAD')).toBe(10);
    expect(scoreFor('MISS')).toBe(0);
    expect(breaksCombo('PERFECT')).toBe(false);
    expect(breaksCombo('GOOD')).toBe(false);
    expect(breaksCombo('BAD')).toBe(true);
    expect(breaksCombo('MISS')).toBe(true);
    expect(breaksCombo('EMPTY')).toBe(true);
  });
  it('EARLY/LATE', () => {
    expect(earlyLateFor('PERFECT', -50)).toBeNull();
    expect(earlyLateFor('GOOD', -100)).toBe('EARLY');
    expect(earlyLateFor('BAD', 200)).toBe('LATE');
  });
  it('入力遅延補正', () => {
    expect(applyInputOffset(1000, 30)).toBe(970);
    expect(clampInputOffset(255)).toBe(200);
    expect(clampInputOffset(-999)).toBe(-200);
    expect(clampInputOffset(14)).toBe(10);
  });
  it('最も近い未判定音符を1つだけ選ぶ。同距離は早い方', () => {
    const notes = [
      { hitAtMs: 1000, judged: false },
      { hitAtMs: 1400, judged: false },
      { hitAtMs: 2000, judged: false },
    ];
    expect(findJudgeTarget(notes, 1200)).toBe(0); // 同距離 → 早い方
    expect(findJudgeTarget(notes, 1250)).toBe(1);
    expect(findJudgeTarget(notes, 1700)).toBe(-1); // 1400 とは 300、2000 とは 300 → 範囲外
    notes[0]!.judged = true;
    expect(findJudgeTarget(notes, 1200)).toBe(1);
    expect(findJudgeTarget(notes, 5000)).toBe(-1);
  });
});
