import { describe, expect, it } from 'vitest';
import { stabilizeBeatGrid } from '../src/features/stableGrid';

describe('一定テンポの拍グリッド安定化', () => {
  it('音が弱いイントロに乱れがあっても、安定区間のテンポと位相を復元する', () => {
    const period = 60000 / 137;
    const truth = Array.from({ length: 260 }, (_, i) => 180 + i * period);
    const noisy = truth.map((t, i) => t + (i < 24 ? 95 * Math.sin(i * 0.7) : 16 * Math.sin(i * 1.7)));
    const r = stabilizeBeatGrid(noisy, noisy.map((_, i) => i < 24 ? 0.001 : 1), 137.2);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bpm - 137)).toBeLessThan(0.1);
    const errors = truth.slice(25, -1).map(t => Math.min(...r!.timesMs.map(n => Math.abs(n - t))));
    expect(Math.max(...errors)).toBeLessThan(10);
  });
  it('途中でテンポが変わる曲は一定グリッドに押し込まない', () => {
    const times: number[] = []; let t = 200;
    for (let i = 0; i < 240; i++) { times.push(t); t += i < 120 ? 480 : 530; }
    expect(stabilizeBeatGrid(times, times.map(() => 1), 120)).toBeNull();
  });
  it('短い曲・無音・不正なテンポでは変更しない', () => {
    expect(stabilizeBeatGrid([0, 500], [1, 1], 120)).toBeNull();
    const times = Array.from({ length: 100 }, (_, i) => i * 500);
    expect(stabilizeBeatGrid(times, times.map(() => 0), 120)).toBeNull();
    expect(stabilizeBeatGrid(times, times.map(() => 1), 0)).toBeNull();
  });
});
