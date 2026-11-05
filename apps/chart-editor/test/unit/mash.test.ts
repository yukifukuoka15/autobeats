import { MASH, type ChartNote } from '@autobeats/chart-format';
import { generateLevel } from '@autobeats/audio-analysis';
import { describe, expect, it } from 'vitest';
import { PlaytestEngine } from '../../src/renderer/src/playtest/engine';
import * as cmd from '../../src/renderer/src/store/document';
import { editorStore } from '../../src/renderer/src/store/editorStore';
import { audioMeta, syntheticAnalysis } from './document.test';

const base = cmd.documentWithAudio(cmd.createEmptyDocument(), audioMeta);

describe('連打（mash）の編集', () => {
  it('F 長押し相当の addMash は区間を持つ連打を追加し、短すぎる・重なる・他レベル近接は拒否する', () => {
    const r = cmd.addMash(base, '1', 5000, 6000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const note = r.doc.levels['1'].notes[0]!;
    expect(note).toMatchObject({ type: 'mash', hitAtMs: 5000, durationMs: 1000, source: 'manual' });
    expect(cmd.addMash(base, '1', 5000, 5000 + MASH.minDurationMs - 1).ok).toBe(false);
    expect(cmd.addMash(base, '1', 6000, 5000).ok).toBe(true); // 逆向きも開始・終了に正規化
    // 同一レベルの区間内へ通常ヒットは置けない
    expect(cmd.addNote(r.doc, '1', 5500).ok).toBe(false);
    // 他レベルは区間全体から 80ms 離れている必要がある
    expect(cmd.addNote(r.doc, '2', 5500).ok).toBe(false);
    expect(cmd.addNote(r.doc, '2', 6080).ok).toBe(false);
    expect(cmd.addNote(r.doc, '2', 6081).ok).toBe(true);
    expect(cmd.addNote(r.doc, '2', 4919).ok).toBe(true);
    // 長さの変更・種類の切替
    const longer = cmd.setNoteDuration(r.doc, '1', note.id, 2000);
    expect(longer.ok && longer.doc.levels['1'].notes[0]!.durationMs === 2000).toBe(true);
    expect(cmd.setNoteDuration(r.doc, '1', note.id, 100).ok).toBe(false);
    const tap = cmd.setNoteType(r.doc, '1', note.id, 'tap');
    expect(tap.ok && tap.doc.levels['1'].notes[0]!.type === 'tap' && tap.doc.levels['1'].notes[0]!.durationMs === undefined).toBe(true);
    // 検証: 区間内のヒットは衝突、最小間隔は終了時刻から
    const bad = { ...r.doc, levels: { ...r.doc.levels, '1': { ...r.doc.levels['1'], notes: [note, { id: 'x', hitAtMs: 5500, source: 'manual' as const }] } } };
    expect(cmd.findNoteIssues(bad).some((i) => i.code === 'collision')).toBe(true);
    // 移動は区間ごと
    const moved = cmd.moveNotes(r.doc, '1', new Set([note.id]), 100);
    expect(moved.ok && moved.doc.levels['1'].notes[0]!.hitAtMs === 5100 && moved.doc.levels['1'].notes[0]!.durationMs === 1000).toBe(true);
  });

  it('ストア: 連打の追加・プレビューは Undo でき、拒否は履歴に積まれない', () => {
    editorStore.replaceDocument(base, { projectName: null });
    editorStore.setMashPreview({ level: '1', startMs: 1000 });
    expect(editorStore.getState().mashPreview).toEqual({ level: '1', startMs: 1000 });
    editorStore.setMashPreview(null);
    expect(editorStore.addMash('1', 1000, 1500)).not.toBeNull();
    expect(editorStore.doc.levels['1'].notes[0]!.type).toBe('mash');
    expect(editorStore.addMash('1', 1200, 1900)).toBeNull(); // 重なり
    expect(editorStore.canUndo).toBe(true);
    editorStore.undo();
    expect(editorStore.doc.levels['1'].notes).toHaveLength(0);
    expect(editorStore.canUndo).toBe(false);
  });

  it('自動解析は連打を生成せず、保持した連打の区間には自動ヒットを置かない', () => {
    const analysis = syntheticAnalysis();
    const mash: ChartNote = { id: 'm', hitAtMs: 10000, source: 'manual', type: 'mash', durationMs: 2000 };
    const notes = generateLevel(2, { analysis, choruses: [], durationMs: 60000, existing: { 2: [mash] }, manualPolicy: 'keep' });
    expect(notes.some((n) => n.type === 'mash' && n.id === 'm')).toBe(true);
    expect(notes.filter((n) => n.type === 'mash')).toHaveLength(1);
    const minGap = 400;
    for (const n of notes) if (n.id !== 'm') expect(n.hitAtMs < 10000 - minGap || n.hitAtMs > 12000 + minGap).toBe(true);
    // 他レベルの生成も連打の区間（80ms 幅）を避ける
    const other = generateLevel(1, { analysis, choruses: [], durationMs: 60000, usedTimes: [{ level: 2, hitAtMs: 10000, durationMs: 2000 }] });
    for (const n of other) expect(n.hitAtMs < 10000 - 80 || n.hitAtMs > 12000 + 80).toBe(true);
  });

  it('プレイテスト: 連打区間内の押下を数え、区間終了時に回数で判定する', () => {
    const levels = { '1': { notes: [{ id: 'm', hitAtMs: 1000, source: 'manual' as const, type: 'mash' as const, durationMs: 800 }, { id: 't', hitAtMs: 3000, source: 'manual' as const }] }, '2': { notes: [] }, '3': { notes: [] }, '4': { notes: [] } };
    const e = new PlaytestEngine(levels, { startMs: 0, durationMs: 5000, inputOffsetMs: 0 });
    for (const t of [1000, 1200, 1400, 1600]) {
      const r = e.press('1', t);
      e.release('1');
      expect(r?.kind).toBe('MASH');
    }
    expect(e.lanes['1'].notes[0]!.presses).toBe(4);
    expect(e.score).toBe(4 * MASH.bonusPerPress);
    e.tick(1800 + MASH.edgeToleranceMs + 1);
    expect(e.lanes['1'].notes[0]!.judgement).toBe('PERFECT'); // 800ms → 必要 4 回
    expect(e.score).toBe(4 * MASH.bonusPerPress + 100);
    expect(e.combo).toBe(1);
    // 通常ヒットは従来どおり
    expect(e.press('1', 3000)?.kind).toBe('PERFECT');
    // 連打は通常のタイミング判定の対象にならない（区間外の押下は空押し）
    const e2 = new PlaytestEngine(levels, { startMs: 0, durationMs: 5000, inputOffsetMs: 0 });
    expect(e2.press('1', 2500)?.kind).toBe('EMPTY');
    e2.tick(2000);
    expect(e2.lanes['1'].notes[0]!.judgement).toBe('MISS');
    expect(e2.endAtMs).toBeGreaterThanOrEqual(5000);
  });
});
