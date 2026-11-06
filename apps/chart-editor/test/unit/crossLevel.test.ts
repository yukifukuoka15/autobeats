import { findCrossLevelConflicts, validateChart, type ChartNote } from '@autobeats/chart-format';
import { describe, expect, it } from 'vitest';
import { documentToChart, exportValidationOptions } from '../../src/main/services/exportPackage';
import * as cmd from '../../src/renderer/src/store/document';
import { editorStore } from '../../src/renderer/src/store/editorStore';
import { audioMeta, syntheticAnalysis } from './document.test';


const note = (id: string, hitAtMs: number): ChartNote => ({ id, hitAtMs, source: 'manual' });
const base = () => cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta);

describe('難易度間の重なりを許可する', () => {
  it.each([0, 1, 79, 80, 81])('他難易度から %ims の位置に追加できる', (delta) => {
    const doc = base();
    doc.levels['2'].notes = [note('other', 5000)];
    const r = cmd.addNote(doc, '1', 5000 + delta);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.levels['1'].notes[0]?.hitAtMs).toBe(5000 + delta);
  });

  it('ドラッグ・複数移動・数値入力で他難易度と重ねられ、Undo/Redoできる', () => {
    const doc = base();
    doc.levels['1'].notes = [note('a', 1000), note('b', 3000)];
    doc.levels['2'].notes = [note('other', 4000)];
    expect(cmd.moveNotes(doc, '1', new Set(['a', 'b']), 1000).ok).toBe(true);
    expect(cmd.setNoteTime(doc, '1', 'a', 4000).ok).toBe(true);
    editorStore.replaceDocument(doc, { projectName: 'overlap' });
    expect(editorStore.addNote('3', 4000)).not.toBeNull();
    editorStore.undo();
    expect(editorStore.doc.levels['3'].notes).toHaveLength(0);
    editorStore.redo();
    expect(editorStore.doc.levels['3'].notes[0]?.hitAtMs).toBe(4000);
  });

  it('同一難易度の重複・最小間隔・曲の範囲は引き続き検証する', () => {
    const doc = base();
    doc.levels['1'].notes = [note('a', 1000)];
    expect(cmd.addNote(doc, '1', 1000).ok).toBe(false);
    expect(cmd.checkPlacement(doc, '1', [{ hitAtMs: 1001 }], { rejectMinGap: true }).ok).toBe(false);
    expect(cmd.addNote(doc, '2', -1).ok).toBe(false);
    expect(cmd.addNote(doc, '2', audioMeta.durationMs).ok).toBe(false);
  });

  it('重なる譜面は読み込み警告・修復なしで検証と書き出しを通る', () => {
    const doc = base();
    doc.levels['1'].notes = [note('a', 1000)];
    doc.levels['2'].notes = [note('b', 1000)];
    doc.levels['3'].notes = [note('c', 1080)];
    expect(cmd.findNoteIssues(doc)).toEqual([]);
    expect(cmd.repairCrossLevelConflicts(doc).doc).toBe(doc);
    editorStore.replaceDocument(doc, { projectName: 'legacy' });
    const chart = documentToChart(doc, 'audio.wav');
    expect(chart.generationRules?.crossLevelNotesAreExclusive).toBe(false);
    expect(chart.generationRules?.crossLevelExclusionMs).toBe(0);
    expect(validateChart(chart, exportValidationOptions(doc)).ok).toBe(true);
  });

  it('自動生成は各難易度を独立して生成し、他レベルの手作業ノーツを避けない', () => {
    const doc = cmd.applyAnalysis(base(), syntheticAnalysis());
    const all = cmd.regenerateLevels(doc, ['1', '2', '3', '4'], 'replace');
    expect(findCrossLevelConflicts(all.doc.levels).total).toBeGreaterThan(0);
    expect(all.reports.every((r) => r.excludedByCrossLevel === 0)).toBe(true);
    const only = cmd.regenerateLevels(doc, ['2'], 'replace').doc.levels['2'].notes;
    expect(all.doc.levels['2'].notes).toEqual(only);
    const withOther = { ...doc, levels: { ...doc.levels, '1': { ...doc.levels['1'], notes: only.map((n) => ({ ...n, id: `other-${n.id}`, source: 'manual' as const })) } } };
    expect(cmd.regenerateLevels(withOther, ['2'], 'replace').doc.levels['2'].notes).toEqual(only);
  });
});