import type { AnalysisResult } from '@autobeats/audio-analysis';
import { describe, expect, it } from 'vitest';
import type { AudioMeta } from '../../src/shared/types';
import * as cmd from '../../src/renderer/src/store/document';
import { editorStore } from '../../src/renderer/src/store/editorStore';

export const audioMeta: AudioMeta = {
  token: 'a'.repeat(32),
  fileName: 'song.wav',
  extension: '.wav',
  sizeBytes: 1000,
  mtimeMs: 0,
  sha256: 'b'.repeat(64),
  displayPath: '~/song.wav',
  durationMs: 60000,
  sampleRate: 44100,
  channels: 2,
};

export function syntheticAnalysis(durationMs = 60000, bpm = 120): AnalysisResult {
  const beatMs = 60000 / bpm;
  const beats: number[] = [];
  const downbeats: number[] = [];
  const onsets: { timeMs: number; strength: number }[] = [];
  for (let i = 0; i * beatMs < durationMs - beatMs; i++) {
    const t = Math.round(i * beatMs);
    beats.push(t);
    if (i % 4 === 0) downbeats.push(t);
    onsets.push({ timeMs: t, strength: i % 4 === 0 ? 1 : 0.6 });
  }
  return {
    engineVersion: '1.0.0',
    analyzedAt: '2026-11-05T00:00:00.000Z',
    durationMs,
    sampleRate: 44100,
    bpm,
    bpmConfidence: 0.9,
    offsetMs: 0,
    beatsPerBar: 4,
    beats,
    downbeats,
    onsets,
    sections: [],
    choruses: [{ id: 'chorus-1', startMs: 20000, endMs: 30000, confidence: 0.8, source: 'detected' }],
    leadInEndMs: 0,
    tailStartMs: durationMs,
    frameHopMs: 11.6,
    energyCurve: [],
    energyCurveStepMs: 100,
  };
}

/** 全レベルの音符から 80ms を超えて離れ、同一レベルの最小間隔も満たす時刻を探す */
export function findFreeTime(doc: ReturnType<typeof cmd.createEmptyDocument>, level: '1' | '2' | '3' | '4', from = 500): number {
  for (let t = from; t < (doc.audio?.durationMs ?? 0); t += 7) {
    if (cmd.checkPlacement(doc, level, [{ hitAtMs: t }], { rejectMinGap: true }).ok) return t;
  }
  throw new Error('空き時刻がありません');
}

describe('document commands', () => {
  const base = cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta);

  it('音符の追加・移動・削除は整数へ丸め、範囲外は拒否し、手作業として記録する', () => {
    const r = cmd.addNote(base, '1', 1234.6);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { doc, id } = r;
    expect(doc.levels['1'].notes[0]).toMatchObject({ id, hitAtMs: 1235, source: 'manual' });
    const moved = cmd.moveNotes(doc, '1', new Set([id]), -5000);
    expect(moved.ok).toBe(false);
    const far = cmd.setNoteTime(doc, '1', id, 999999);
    expect(far.ok).toBe(false);
    const ok = cmd.setNoteTime(doc, '1', id, 59999);
    expect(ok.ok && ok.doc.levels['1'].notes[0]!.hitAtMs === 59999).toBe(true);
    expect(cmd.deleteNotes(doc, '1', new Set([id])).levels['1'].notes).toHaveLength(0);
    expect(base.levels['1'].notes).toHaveLength(0); // 不変
  });

  it('サビ区間の追加・更新・移動・結合', () => {
    const a = cmd.addChorus(base, 10000, 5000);
    expect(a.doc.choruses[0]).toMatchObject({ startMs: 5000, endMs: 10000, source: 'manual' });
    const b = cmd.addChorus(a.doc, 8000, 15000);
    const merged = cmd.mergeOverlappingChoruses(b.doc);
    expect(merged.choruses).toHaveLength(1);
    expect(merged.choruses[0]).toMatchObject({ startMs: 5000, endMs: 15000 });
    const moved = cmd.moveChorus(merged, merged.choruses[0]!.id, 100000);
    expect(moved.choruses[0]).toMatchObject({ startMs: 50000, endMs: 60000 });
    const resized = cmd.updateChorus(moved, moved.choruses[0]!.id, { endMs: 1 });
    expect(resized.choruses[0]!.endMs).toBe(50001);
  });

  it('解析適用で4レベルを生成し、再生成で手作業音符の保持・置換を選べる', () => {
    const analysis = syntheticAnalysis();
    const applied = cmd.regenerateLevels(cmd.applyAnalysis(base, analysis), ['1', '2', '3', '4'], 'replace').doc;
    expect(applied.bpm).toBe(120);
    expect(applied.choruses).toHaveLength(1);
    const counts = (['1', '2', '3', '4'] as const).map((k) => applied.levels[k].notes.length);
    expect(counts[0]).toBeGreaterThan(0);
    expect(cmd.hasCrossLevelConflicts(applied)).toBe(false);
    // 他レベルの音符から 80ms を超えて離れた位置へ手作業音符を置く
    const free = findFreeTime(applied, '2');
    const added = cmd.addNote(applied, '2', free);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const withManual = added.doc;
    const kept = cmd.regenerateLevels(withManual, ['2'], 'keep').doc;
    expect(kept.levels['2'].notes.some((n) => n.source === 'manual' && n.hitAtMs === free)).toBe(true);
    const replaced = cmd.regenerateLevels(withManual, ['2'], 'replace').doc;
    expect(replaced.levels['2'].notes.some((n) => n.source === 'manual')).toBe(false);
    // 他レベルは変わらない
    expect(kept.levels['3']).toBe(withManual.levels['3']);
  });

  it('違反（同一レベル重複・最小間隔・難易度間）を検出し、同一レベルの同時刻追加は拒否する', () => {
    const a = cmd.addNote(base, '1', 1000);
    if (!a.ok) throw new Error(a.message);
    expect(cmd.addNote(a.doc, '1', 1000).ok).toBe(false);
    const b = cmd.addNote(a.doc, '1', 1300);
    if (!b.ok) throw new Error(b.message);
    // 直接データを作った場合（読み込みなど）は検出できる
    const raw = { ...b.doc, levels: { ...b.doc.levels, '1': { ...b.doc.levels['1'], notes: [...b.doc.levels['1'].notes, { id: 'dup', hitAtMs: 1000, source: 'manual' as const }] }, '2': { ...b.doc.levels['2'], notes: [{ id: 'x', hitAtMs: 1040, source: 'manual' as const }] } } };
    const issues = cmd.findNoteIssues(raw);
    expect(issues.some((i) => i.code === 'collision')).toBe(true);
    expect(issues.some((i) => i.code === 'min-gap')).toBe(true);
    expect(issues.filter((i) => i.code === 'cross-level')).toHaveLength(2);
    const summary = cmd.summarizeIssues(issues);
    expect(summary.crossLevelByPair['1-2']).toBe(2);
  });
});

describe('editorStore', () => {
  it('音符とサビの編集を Undo/Redo で往復でき、保存位置で未保存が解除される', () => {
    editorStore.replaceDocument(cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta), { projectName: 'test' });
    expect(editorStore.dirty).toBe(false);
    const id = editorStore.addNote('1', 1000)!;
    editorStore.addChorus(5000, 9000);
    expect(editorStore.doc.levels['1'].notes).toHaveLength(1);
    expect(editorStore.doc.choruses).toHaveLength(1);
    expect(editorStore.dirty).toBe(true);
    editorStore.undo();
    expect(editorStore.doc.choruses).toHaveLength(0);
    editorStore.undo();
    expect(editorStore.doc.levels['1'].notes).toHaveLength(0);
    expect(editorStore.dirty).toBe(false);
    editorStore.redo();
    editorStore.redo();
    expect(editorStore.doc.choruses).toHaveLength(1);
    editorStore.markSaved('test');
    expect(editorStore.dirty).toBe(false);
    editorStore.setSelection({ kind: 'notes', level: '1', ids: new Set([id]) });
    editorStore.moveSelectedNotes(250);
    expect(editorStore.doc.levels['1'].notes[0]!.hitAtMs).toBe(1250);
    expect(editorStore.dirty).toBe(true);
    editorStore.undo();
    expect(editorStore.dirty).toBe(false);
  });

  it('解析適用後の再生成が1操作で Undo できる', () => {
    editorStore.replaceDocument(cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta), { projectName: null });
    editorStore.applyAnalysis(syntheticAnalysis());
    const before = editorStore.doc.levels['4'].notes.length;
    expect(before).toBeGreaterThan(0);
    editorStore.setLevelSettings('4', { density: 0.1 });
    editorStore.regenerate(['4'], 'replace');
    expect(editorStore.doc.levels['4'].notes.length).toBeLessThan(before);
    editorStore.undo();
    expect(editorStore.doc.levels['4'].notes.length).toBe(before);
  });
});
