import { CROSS_LEVEL_EXCLUSION_MS, findCrossLevelConflicts, isCrossLevelConflict, validateChart, type ChartNote } from '@autobeats/chart-format';
import { describe, expect, it } from 'vitest';
import { documentToChart } from '../../src/main/services/exportPackage';
import * as cmd from '../../src/renderer/src/store/document';
import { editorStore } from '../../src/renderer/src/store/editorStore';
import type { EditorDocument } from '../../src/shared/types';
import { audioMeta, findFreeTime, syntheticAnalysis } from './document.test';

const note = (id: string, hitAtMs: number, source: ChartNote['source'] = 'generated'): ChartNote => ({ id, hitAtMs, source });

function docWithLevels(levels: Partial<Record<'1' | '2' | '3' | '4', ChartNote[]>>): EditorDocument {
  const base = cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta);
  const out = { ...base, levels: { ...base.levels } };
  for (const k of ['1', '2', '3', '4'] as const) out.levels[k] = { ...out.levels[k], notes: levels[k] ?? [] };
  return out;
}

describe('難易度間の除外幅（共通判定）', () => {
  it('完全一致・1ms・79ms・80ms は衝突、81ms は非衝突', () => {
    expect(isCrossLevelConflict(5000, 5000, CROSS_LEVEL_EXCLUSION_MS)).toBe(true);
    expect(isCrossLevelConflict(5000, 5001, CROSS_LEVEL_EXCLUSION_MS)).toBe(true);
    expect(isCrossLevelConflict(5000, 5079, CROSS_LEVEL_EXCLUSION_MS)).toBe(true);
    expect(isCrossLevelConflict(5000, 5080, CROSS_LEVEL_EXCLUSION_MS)).toBe(true);
    expect(isCrossLevelConflict(5000, 5081, CROSS_LEVEL_EXCLUSION_MS)).toBe(false);
  });

  it('同じレベルの音符は難易度間衝突ではなく同一レベル検証へ渡る', () => {
    const doc = docWithLevels({ '1': [note('a', 1000), note('b', 1000), note('c', 1300)] });
    const issues = cmd.findNoteIssues(doc);
    expect(issues.some((i) => i.code === 'cross-level')).toBe(false);
    expect(issues.some((i) => i.code === 'collision')).toBe(true);
    expect(issues.some((i) => i.code === 'min-gap')).toBe(true);
  });

  it('自動生成は L1 付近に L2～L4、L2 付近に L3・L4、L3 付近に L4 を置かない', () => {
    const base = cmd.applyAnalysis(cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta), syntheticAnalysis());
    const doc = cmd.regenerateLevels(base, ['1', '2', '3', '4'], 'replace').doc;
    const report = findCrossLevelConflicts(doc.levels, CROSS_LEVEL_EXCLUSION_MS);
    for (const k of ['1-2', '1-3', '1-4', '2-3', '2-4', '3-4'] as const) expect(report.countsByPair[k], k).toBe(0);
    expect(doc.levels['1'].notes.length).toBeGreaterThan(0);
    expect(doc.levels['2'].notes.length).toBeGreaterThan(0);
  });

  it('衝突候補が拒否された後に次点候補を採用し、代替がなければ音符数を減らして報告する', () => {
    const base = cmd.applyAnalysis(cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta), syntheticAnalysis());
    const outcome = cmd.regenerateLevels(base, ['1', '2', '3', '4'], 'replace');
    const l2 = outcome.reports.find((r) => r.level === 2)!;
    expect(l2.excludedByCrossLevel).toBeGreaterThan(0);
    expect(l2.generatedCount).toBeGreaterThan(0);
    // 目標に届かないレベルは日本語警告を持つ
    const short = outcome.reports.filter((r) => r.generatedCount < r.targetCount);
    expect(outcome.shortfalls.length).toBe(short.length);
    for (const s of outcome.shortfalls) expect(s).toMatch(/目標ヒット数に達しませんでした/);
  });

  it('手動追加で衝突を拒否し、相手レベル・時刻・差・必要間隔を含むメッセージを返す', () => {
    const doc = docWithLevels({ '2': [note('x', 24560, 'manual')] });
    const r = cmd.addNote(doc, '1', 24602);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('LEVEL 2のヒット（00:24.560）');
    expect(r.message).toContain('42ms');
    expect(r.message).toContain('80ms');
    expect(r.conflict).toMatchObject({ level: 2, diffMs: 42 });
    expect(cmd.addNote(doc, '1', 24641).ok).toBe(true); // 81ms 離れていれば可
  });

  it('ドラッグ移動（moveNotes）で衝突を拒否する', () => {
    const doc = docWithLevels({ '1': [note('a', 1000, 'manual')], '2': [note('b', 2000, 'manual')] });
    expect(cmd.moveNotes(doc, '1', new Set(['a']), 1000).ok).toBe(false);
    expect(cmd.moveNotes(doc, '1', new Set(['a']), 920).ok).toBe(false); // 1920: 差 80 → 衝突
    expect(cmd.moveNotes(doc, '1', new Set(['a']), 919).ok).toBe(true); // 1919: 差 81 → 可
    expect(cmd.setNoteTime(doc, '1', 'a', 2050).ok).toBe(false);
  });

  it('複数選択移動は 1 音でも不正なら全体を拒否する（原子的）', () => {
    const doc = docWithLevels({ '1': [note('a', 1000, 'manual'), note('b', 3000, 'manual')], '2': [note('c', 4000, 'manual')] });
    const r = cmd.moveNotes(doc, '1', new Set(['a', 'b']), 1000); // b → 4000 が L2 と衝突
    expect(r.ok).toBe(false);
    const ok = cmd.moveNotes(doc, '1', new Set(['a', 'b']), 500);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.doc.levels['1'].notes.map((n) => n.hitAtMs)).toEqual([1500, 3500]);
    // 同一レベルの最小間隔違反も複数移動では拒否
    const tight = docWithLevels({ '1': [note('a', 1000, 'manual'), note('b', 3000, 'manual'), note('c', 3300, 'manual')] });
    expect(cmd.moveNotes(tight, '1', new Set(['a', 'b']), 10).ok).toBe(false);
  });

  it('書き出し前検証（validateChart）で異レベル衝突を全件検出する', () => {
    const doc = docWithLevels({ '1': [note('a', 1000), note('b', 5000)], '2': [note('c', 1040), note('d', 5080)], '3': [note('e', 9000)] });
    const chart = documentToChart(doc, 'audio.wav');
    expect(chart.generationRules).toEqual({ crossLevelExclusionMs: 80, levelPriority: [1, 2, 3, 4], crossLevelNotesAreExclusive: true });
    const r = validateChart(chart, { crossLevelExclusionMs: CROSS_LEVEL_EXCLUSION_MS });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.filter((e) => e.code === 'cross-level')).toHaveLength(2);
  });

  it('修復処理は LEVEL 1 を優先して保持し、高いレベルの音符を移動または削除する', () => {
    const base = cmd.applyAnalysis(cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta), syntheticAnalysis());
    const l1 = [note('a1', 1000), note('a2', 3000)];
    const doc = { ...base, levels: { ...base.levels, '1': { ...base.levels['1'], notes: l1 }, '2': { ...base.levels['2'], notes: [note('b1', 1040), note('b2', 3010), note('b3', 10000)] }, '3': { ...base.levels['3'], notes: [note('c1', 1000)] } } };
    const r = cmd.repairCrossLevelConflicts(doc);
    expect(r.doc.levels['1'].notes).toEqual(l1);
    expect(r.unresolved).toBe(0);
    expect(r.moved + r.deleted).toBeGreaterThanOrEqual(3);
    expect(findCrossLevelConflicts(r.doc.levels, CROSS_LEVEL_EXCLUSION_MS).total).toBe(0);
    expect(r.doc.levels['2'].notes.some((n) => n.id === 'b3' && n.hitAtMs === 10000)).toBe(true);
    for (const n of r.doc.levels['2'].notes) expect(cmd.checkPlacement({ ...r.doc, levels: { ...r.doc.levels, '2': { ...r.doc.levels['2'], notes: r.doc.levels['2'].notes.filter((o) => o.id !== n.id) } } }, '2', [{ hitAtMs: n.hitAtMs }], { rejectMinGap: true }).ok).toBe(true);
  });

  it('修復操作と拒否された操作: 修復は 1 回の Undo で戻り、拒否は履歴へ積まれない', () => {
    const base = cmd.applyAnalysis(cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta), syntheticAnalysis());
    const doc = { ...base, levels: { ...base.levels, '1': { ...base.levels['1'], notes: [note('a1', 1000)] }, '2': { ...base.levels['2'], notes: [note('b1', 1040)] } } };
    editorStore.replaceDocument(doc, { projectName: 'conflict' });
    expect(editorStore.canUndo).toBe(false);
    const r = editorStore.repairConflicts();
    expect(r.moved + r.deleted).toBe(1);
    expect(cmd.hasCrossLevelConflicts(editorStore.doc)).toBe(false);
    expect(editorStore.canUndo).toBe(true);
    editorStore.undo();
    expect(editorStore.doc).toEqual(doc);
    expect(editorStore.canUndo).toBe(false);
    // 拒否される追加は履歴へ積まれず、未保存にもならない
    expect(editorStore.addNote('3', 1020)).toBeNull();
    expect(editorStore.canUndo).toBe(false);
    expect(editorStore.dirty).toBe(false);
    expect(editorStore.getState().status?.kind).toBe('error');
    // 読み取り専用中は編集を拒否
    editorStore.setReadOnly(true);
    expect(editorStore.addNote('3', findFreeTime(editorStore.doc, '3'))).toBeNull();
    editorStore.setReadOnly(false);
    expect(editorStore.addNote('3', findFreeTime(editorStore.doc, '3'))).not.toBeNull();
  });
});
