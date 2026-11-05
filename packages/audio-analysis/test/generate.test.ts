import { CROSS_LEVEL_EXCLUSION_MS, DEFAULT_LEVEL_SETTINGS, LEVEL_NUMBERS, findCrossLevelConflicts, type ChartNote, type ChorusSection, type LevelNumber, type UsedNoteTime } from '@autobeats/chart-format';
import { describe, expect, it } from 'vitest';
import { analyzeAudio, generateAllLevels, generateLevel, generateLevelDetailed, makeRng, silence, synthesizeSongLike, type GenerationAnalysis } from '../src';

/**
 * 統計的に一様な特徴を持つ合成解析結果。
 * 小節頭は強度 1.0、それ以外のグリッド点は決定的疑似乱数で 0.1～1.0 の強度を持つ。
 * 10 秒ごとに同じ乱数列を繰り返すので、10 秒区間同士は同等の特徴になる。
 */
function uniformAnalysis(durationMs: number, bpm = 100): GenerationAnalysis {
  const beatMs = 60000 / bpm;
  const beats: number[] = [];
  const downbeats: number[] = [];
  const onsets: { timeMs: number; strength: number }[] = [];
  const rng = makeRng(99);
  const pattern: number[] = Array.from({ length: 4000 }, () => 0.1 + 0.9 * rng());
  let k = 0;
  for (let i = 0; i * beatMs < durationMs - beatMs; i++) {
    const t = Math.round(i * beatMs);
    beats.push(t);
    if (i % 4 === 0) downbeats.push(t);
    const strengthAt = () => pattern[k++ % pattern.length]!;
    onsets.push({ timeMs: t, strength: i % 4 === 0 ? 1 : strengthAt() });
    onsets.push({ timeMs: Math.round(t + beatMs / 2), strength: strengthAt() });
    onsets.push({ timeMs: Math.round(t + beatMs / 4), strength: strengthAt() * 0.6 });
    onsets.push({ timeMs: Math.round(t + (3 * beatMs) / 4), strength: strengthAt() * 0.6 });
  }
  return { beats, downbeats, onsets, leadInEndMs: 0, tailStartMs: durationMs, bpm, beatsPerBar: 4 };
}

function assertLevelInvariants(notes: ChartNote[], level: LevelNumber, durationMs: number) {
  const minGap = DEFAULT_LEVEL_SETTINGS[level].minGapMs;
  const times = new Set<number>();
  const ids = new Set<string>();
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!;
    expect(Number.isInteger(n.hitAtMs)).toBe(true);
    expect(n.hitAtMs).toBeGreaterThanOrEqual(0);
    expect(n.hitAtMs).toBeLessThan(durationMs);
    expect(times.has(n.hitAtMs)).toBe(false);
    times.add(n.hitAtMs);
    expect(ids.has(n.id)).toBe(false);
    ids.add(n.id);
    if (i > 0 && n.source === 'generated' && notes[i - 1]!.source === 'generated') {
      expect(n.hitAtMs - notes[i - 1]!.hitAtMs).toBeGreaterThanOrEqual(minGap);
    }
  }
}

describe('generateLevel', () => {
  const durationMs = 60000;
  const analysis = uniformAnalysis(durationMs);
  const noChorus: ChorusSection[] = [];

  it('LEVEL 1～4 を別設定で個別生成し、上位ほど音符が増える', () => {
    const levels = generateAllLevels({ analysis, choruses: noChorus, durationMs });
    const counts = LEVEL_NUMBERS.map((l) => levels[l]!.length);
    expect(counts[0]).toBeGreaterThan(0);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
    // 上位レベルが下位レベルの全音符を含む必要はないが、生成理由は異なる
    const reasons = (l: LevelNumber) => new Set(levels[l]!.map((n) => n.reason));
    expect(reasons(1).has('offbeat')).toBe(false);
    expect(reasons(3).has('offbeat') || reasons(4).has('offbeat')).toBe(true);
    for (const l of LEVEL_NUMBERS) assertLevelInvariants(levels[l]!, l, durationMs);
  });

  it('レベルごとの最小間隔を守り、同時刻を重複させない', () => {
    for (const l of LEVEL_NUMBERS) {
      const notes = generateLevel(l, { analysis, choruses: noChorus, durationMs, settings: { [l]: { ...DEFAULT_LEVEL_SETTINGS[l], density: 1 } } });
      assertLevelInvariants(notes, l, durationMs);
    }
  });

  it('サビ区間内の密度が、同等特徴の非サビ区間より増える', () => {
    const chorus: ChorusSection[] = [{ id: 'c', startMs: 12000, endMs: 24000, confidence: 0.9, source: 'manual' }];
    for (const l of LEVEL_NUMBERS) {
      const notes = generateLevel(l, { analysis, choruses: chorus, durationMs });
      const inChorus = notes.filter((n) => n.hitAtMs >= 12000 && n.hitAtMs < 24000).length;
      const outside = notes.filter((n) => n.hitAtMs >= 24000 && n.hitAtMs < 36000).length;
      expect(inChorus, `LEVEL ${l}`).toBeGreaterThan(outside);
      assertLevelInvariants(notes, l, durationMs);
    }
  });

  it('サビ開始点に機械的な密集を作らない', () => {
    const chorus: ChorusSection[] = [{ id: 'c', startMs: 12000, endMs: 24000, confidence: 0.9, source: 'manual' }];
    const notes = generateLevel(4, { analysis, choruses: chorus, durationMs });
    const first = notes.filter((n) => n.hitAtMs >= 12000 && n.hitAtMs < 13200).length;
    const later = notes.filter((n) => n.hitAtMs >= 16800 && n.hitAtMs < 18000).length;
    expect(first).toBeLessThanOrEqual(later + 2);
  });

  it('曲頭・曲末の無音区間へ音符を置かない', () => {
    const a = { ...analysis, leadInEndMs: 5000, tailStartMs: 50000 };
    for (const l of LEVEL_NUMBERS) {
      const notes = generateLevel(l, { analysis: a, choruses: noChorus, durationMs });
      expect(notes.every((n) => n.hitAtMs >= 4980 && n.hitAtMs < 50000)).toBe(true);
    }
  });

  it('手作業音符の保持・置換を選べる', () => {
    const manual: ChartNote[] = [
      { id: 'm1', hitAtMs: 1234, source: 'manual' },
      { id: 'm2', hitAtMs: 1300, source: 'manual' },
    ];
    const oldGenerated: ChartNote = { id: 'l2-note-1', hitAtMs: 5000, source: 'generated', reason: 'beat' };
    const kept = generateLevel(2, { analysis, choruses: noChorus, durationMs, existing: { 2: [...manual, oldGenerated] }, manualPolicy: 'keep' });
    expect(kept.filter((n) => n.source === 'manual').map((n) => n.id)).toEqual(['m1', 'm2']);
    // 生成音符は手作業音符との最小間隔を守る
    for (const n of kept.filter((n) => n.source === 'generated')) {
      for (const m of manual) expect(Math.abs(n.hitAtMs - m.hitAtMs)).toBeGreaterThanOrEqual(DEFAULT_LEVEL_SETTINGS[2].minGapMs);
    }
    // 生成 ID は手作業 ID と衝突しない
    expect(new Set(kept.map((n) => n.id)).size).toBe(kept.length);
    const replaced = generateLevel(2, { analysis, choruses: noChorus, durationMs, existing: { 2: [...manual, oldGenerated] }, manualPolicy: 'replace' });
    expect(replaced.some((n) => n.source === 'manual')).toBe(false);
  });

  it('同じ入力からは常に同じ出力を得る（決定的）', () => {
    const a = generateLevel(3, { analysis, choruses: noChorus, durationMs });
    const b = generateLevel(3, { analysis, choruses: noChorus, durationMs });
    expect(a).toEqual(b);
  });

  it('無音の解析結果から音符を生成しない', async () => {
    const sampleRate = 22050;
    const r = await analyzeAudio({ sampleRate, channels: [silence(12, sampleRate)] });
    const levels = generateAllLevels({ analysis: r, choruses: r.choruses, durationMs: r.durationMs });
    for (const l of LEVEL_NUMBERS) expect(levels[l]!.length).toBe(0);
  });

  it('合成曲の解析結果から実用的な密度で生成できる', async () => {
    const sampleRate = 22050;
    const song = synthesizeSongLike({ bpm: 120, sampleRate, sections: [{ kind: 'verse', bars: 8 }, { kind: 'chorus', bars: 8 }] });
    const r = await analyzeAudio({ sampleRate, channels: [song.pcm] });
    const levels = generateAllLevels({ analysis: r, choruses: r.choruses, durationMs: r.durationMs });
    const bars = 16;
    const perBar = LEVEL_NUMBERS.map((l) => levels[l]!.length / bars);
    // L1: 1～2音/小節程度、L4 はそれより密
    expect(perBar[0]).toBeGreaterThanOrEqual(0.8);
    expect(perBar[0]).toBeLessThanOrEqual(2.5);
    expect(perBar[3]).toBeGreaterThan(perBar[0]!);
    for (const l of LEVEL_NUMBERS) assertLevelInvariants(levels[l]!, l, r.durationMs);
  });
});

describe('難易度間除外（crossLevelExclusionMs）', () => {
  const durationMs = 60000;
  const analysis = uniformAnalysis(durationMs);

  it('LEVEL 1→4 の順に生成し、全レベル組み合わせで 80ms 以内の衝突が 0 件になる', () => {
    const levels = generateAllLevels({ analysis, choruses: [], durationMs });
    const asLevels = { '1': { notes: levels[1]! }, '2': { notes: levels[2]! }, '3': { notes: levels[3]! }, '4': { notes: levels[4]! } };
    const report = findCrossLevelConflicts(asLevels, CROSS_LEVEL_EXCLUSION_MS);
    expect(report.total, JSON.stringify(report.countsByPair)).toBe(0);
    for (const l of LEVEL_NUMBERS) expect(levels[l]!.length).toBeGreaterThan(0);
    for (const l of LEVEL_NUMBERS) assertLevelInvariants(levels[l]!, l, durationMs);
  });

  it('L1 の音符付近に L2～L4 を、L2 付近に L3・L4 を、L3 付近に L4 を生成しない', () => {
    const levels = generateAllLevels({ analysis, choruses: [{ id: 'c', startMs: 12000, endMs: 30000, confidence: 1, source: 'manual' }], durationMs });
    const near = (a: ChartNote[], b: ChartNote[]) => a.filter((x) => b.some((y) => Math.abs(x.hitAtMs - y.hitAtMs) <= 80)).length;
    expect(near(levels[2]!, levels[1]!)).toBe(0);
    expect(near(levels[3]!, levels[1]!)).toBe(0);
    expect(near(levels[4]!, levels[1]!)).toBe(0);
    expect(near(levels[3]!, levels[2]!)).toBe(0);
    expect(near(levels[4]!, levels[2]!)).toBe(0);
    expect(near(levels[4]!, levels[3]!)).toBe(0);
  });

  it('衝突候補が拒否された後は次点候補を採用する', () => {
    const a: GenerationAnalysis = {
      beats: [1000, 1500, 2000, 2500],
      downbeats: [1000],
      onsets: [
        { timeMs: 1000, strength: 1 },
        { timeMs: 1300, strength: 0.6 },
      ],
      leadInEndMs: 0,
      tailStartMs: 4000,
      bpm: 120,
      beatsPerBar: 4,
    };
    const free = generateLevel(2, { analysis: a, choruses: [], durationMs: 4000 });
    expect(free.map((n) => n.hitAtMs)).toContain(1000);
    const blocked = generateLevelDetailed(2, { analysis: a, choruses: [], durationMs: 4000, usedTimes: [{ level: 1, hitAtMs: 1000 }] });
    expect(blocked.notes.map((n) => n.hitAtMs)).not.toContain(1000);
    // 衝突した 1000ms の代わりに、80ms より離れた次点の音楽的候補（拍またはオンセット）を採用する
    expect(blocked.notes.length).toBe(free.length);
    expect(blocked.notes.every((n) => n.hitAtMs > 1080)).toBe(true);
    expect(blocked.excludedByCrossLevel).toBeGreaterThan(0);
    expect(blocked.generatedCount).toBe(blocked.targetCount);
  });

  it('代替候補がなければ音符数を減らし、目標数との差を報告する', () => {
    const used: UsedNoteTime[] = analysis.beats.map((t) => ({ level: 1, hitAtMs: t }));
    // 1 拍 600ms（100 BPM）で全拍が使用済みなら、裏拍（300ms 離れ）しか残らず L2 の候補は大幅に減る
    const r = generateLevelDetailed(2, { analysis, choruses: [], durationMs, usedTimes: used });
    expect(r.generatedCount).toBeLessThan(r.targetCount);
    expect(r.notes.every((n) => !used.some((u) => Math.abs(u.hitAtMs - n.hitAtMs) <= 80))).toBe(true);
    const all = generateLevelDetailed(2, {
      analysis,
      choruses: [],
      durationMs,
      usedTimes: analysis.onsets.map((o) => ({ level: 1 as const, hitAtMs: o.timeMs })),
    });
    expect(all.generatedCount).toBe(0);
    expect(all.targetCount).toBeGreaterThan(0);
  });

  it('保持した他レベルの手作業音符とも衝突しない。一部レベルだけ再生成しても他レベルの既存音符を避ける', () => {
    const base = generateAllLevels({ analysis, choruses: [], durationMs });
    const manual: ChartNote = { id: 'm1', hitAtMs: 2222, source: 'manual' };
    const existing = { 1: base[1]!, 2: [...base[2]!, manual], 3: base[3]!, 4: base[4]! };
    const regen = generateAllLevels({ analysis, choruses: [], durationMs, existing, manualPolicy: 'keep' }, [3, 4]);
    const l3 = regen[3]!;
    const l4 = regen[4]!;
    for (const n of [...l3, ...l4]) {
      expect(Math.abs(n.hitAtMs - manual.hitAtMs)).toBeGreaterThan(80);
      for (const o of [...existing[1], ...existing[2]]) expect(Math.abs(n.hitAtMs - o.hitAtMs)).toBeGreaterThan(80);
    }
    for (const n of l4) for (const o of l3) expect(Math.abs(n.hitAtMs - o.hitAtMs)).toBeGreaterThan(80);
  });
});
