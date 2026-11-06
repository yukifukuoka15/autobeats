import { describe, expect, it } from 'vitest';
import { findCrossLevelConflicts } from '@autobeats/chart-format';
import { documentToChart, exportChartJson } from '../../src/main/services/exportPackage';
import { buildProjectFile, parseProjectText, projectToDocument } from '../../src/main/services/project';
import * as cmd from '../../src/renderer/src/store/document';
import { editorStore } from '../../src/renderer/src/store/editorStore';
import { audioMeta, syntheticAnalysis } from './document.test';

const base = () => cmd.applyAnalysis(cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta), syntheticAnalysis());
const note = (id: string, hitAtMs: number) => ({ id, hitAtMs, source: 'manual' as const });

describe('Lv1を土台にする追加譜面', () => {
  it('空のLv1を生成し、Lv2/Lv3は重複しない追加分だけを持つ。Lv4は生成しない', () => {
    const r = cmd.regenerateLevels(base(), ['1', '2', '3', '4'], 'replace');
    for (const k of ['1', '2', '3'] as const) expect(r.doc.levels[k].notes.length).toBeGreaterThan(0);
    expect(r.doc.levels['4'].notes).toHaveLength(0);
    expect(findCrossLevelConflicts(r.doc.levels, 80).total).toBe(0);
    expect(cmd.findNoteIssues(r.doc)).toHaveLength(0);
  });

  it('Lv1があればreplaceでも完全に保持し、Lv2/Lv3を順に作る', () => {
    const doc = base();
    doc.levels['1'].notes = [note('a', 1000), note('b', 4000), note('c', 8000), note('d', 12000)];
    const r = cmd.regenerateLevels(doc, ['1', '2', '3'], 'replace');
    expect(r.doc.levels['1']).toBe(doc.levels['1']);
    expect(r.doc.levels['2'].notes.length).toBeGreaterThan(0);
    expect(r.doc.levels['3'].notes.length).toBeGreaterThan(0);
    expect(findCrossLevelConflicts(r.doc.levels, 80).total).toBe(0);
    for (const k of ['2', '3'] as const) for (const n of r.doc.levels[k].notes) {
      expect(n.hitAtMs).toBeGreaterThan(1000);
      expect(n.hitAtMs).toBeLessThan(12000);
    }
  });

  it.each([0, 1, 79, 80])('統合後の %ims の接近は追加・移動・数値入力で拒否する', (delta) => {
    const doc = base();
    doc.levels['1'].notes = [note('a', 1000)];
    doc.levels['2'].notes = [note('b', 3000)];
    expect(cmd.addNote(doc, '3', 1000 + delta).ok).toBe(false);
    expect(cmd.moveNotes(doc, '2', new Set(['b']), -2000 + delta).ok).toBe(false);
    expect(cmd.setNoteTime(doc, '2', 'b', 1000 + delta).ok).toBe(false);
    expect(cmd.addNote(doc, '3', 1081).ok).toBe(true);
  });

  it('連打区間と境界80msも避け、長さをそのまま書き出す', () => {
    const doc = base();
    doc.levels['1'].notes = [{ ...note('m', 1000), type: 'mash', durationMs: 1000 }];
    expect(cmd.addNote(doc, '2', 1500).ok).toBe(false);
    expect(cmd.addNote(doc, '2', 2080).ok).toBe(false);
    expect(cmd.addNote(doc, '2', 2081).ok).toBe(true);
    expect(documentToChart(doc, 'audio.wav').levels['1'].notes[0]?.durationMs).toBe(1000);
  });

  it('再生成で手直しした追加分を保持でき、Undoで戻せる', () => {
    const doc = base();
    doc.levels['1'].notes = [note('a', 1000), note('b', 10000)];
    doc.levels['2'].notes = [note('manual', 2500)];
    editorStore.replaceDocument(doc, { projectName: null });
    editorStore.regenerate(['2', '3'], 'keep');
    expect(editorStore.doc.levels['2'].notes.some((n) => n.id === 'manual')).toBe(true);
    expect(editorStore.doc.levels['1'].notes).toEqual(doc.levels['1'].notes);
    editorStore.undo(); expect(editorStore.doc).toEqual(doc);
    editorStore.redo(); expect(editorStore.doc.levels['3'].notes.length).toBeGreaterThan(0);
  });

  it('プロジェクト保存・再読込で追加方式を保持し、古い譜面は独立方式で読む', () => {
    const doc = base();
    const p = buildProjectFile({ document: doc, audioPath: 'reference.wav', view: null });
    const r = projectToDocument(parseProjectText(JSON.stringify(p)), 'token', 'reference.wav');
    expect(r.noteMode).toBe('additive');
    const { noteMode: _mode, ...legacy } = p;
    expect(projectToDocument(parseProjectText(JSON.stringify(legacy)), 'token', 'reference.wav').noteMode).toBe('independent');
    expect(documentToChart(doc, 'audio.wav').generationRules).toMatchObject({ noteMode: 'additive', crossLevelExclusionMs: 80 });
  });

  it('下位譜面の変更等で80ms以内の既存追加分があれば検証・書き出しで通知する', async () => {
    const doc = base();
    doc.levels['1'].notes = [note('a', 1000)];
    doc.levels['2'].notes = [note('b', 1080)];
    expect(cmd.findNoteIssues(doc).some((i) => i.code === 'cross-level')).toBe(true);
    const result = await exportChartJson(doc, 'should-not-write.json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.code === 'cross-level')).toBe(true);
  });
});

it('やさしく作り直す指定時だけ既存Lv1の自動生成分を減らし、手作業は保持する', () => {
  const doc = base();
  doc.levels['1'].notes = Array.from({ length: 100 }, (_, i) => ({ id: `dense-${i}`, hitAtMs: 1000 + i * 500, source: 'generated' as const }));
  doc.levels['1'].notes.push(note('hand', 52000));
  doc.levels['2'].notes = [note('hand2', 53200)];
  const easier = cmd.withEasySettings(doc);
  const kept = cmd.regenerateLevels(easier, ['2', '3'], 'keep');
  expect(kept.doc.levels['1']).toBe(doc.levels['1']);
  const changed = cmd.regenerateLevels(easier, ['2', '3'], 'keep', true).doc;
  expect(changed.levels['1'].notes.length).toBeLessThan(doc.levels['1'].notes.length);
  expect(changed.levels['1'].notes.some(n => n.id === 'hand' && n.hitAtMs === 52000)).toBe(true);
  expect(changed.levels['2'].notes.some(n => n.id === 'hand2')).toBe(true);
  expect(changed.levels['4'].notes).toHaveLength(0);
  expect(cmd.findNoteIssues(changed)).toEqual([]);
});
