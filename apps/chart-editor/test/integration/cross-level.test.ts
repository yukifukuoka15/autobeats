import { CROSS_LEVEL_EXCLUSION_MS, LEVEL_KEYS, findCrossLevelConflicts, verifyChartPackage, type ChartNote } from '@autobeats/chart-format';
import { nodePackageFs, sha256File } from '@autobeats/chart-format/node';
import { analyzeAudio, decodeWav } from '@autobeats/audio-analysis';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportGamePackage } from '../../src/main/services/exportPackage';
import { buildProjectFile, projectToDocument, readProjectFile, writeProjectFile } from '../../src/main/services/project';
import * as cmd from '../../src/renderer/src/store/document';
import type { EditorDocument } from '../../src/shared/types';

const FIXTURE = path.resolve(__dirname, '../../../../fixtures/generated/song.wav');

describe('難易度間の重複排除（統合）', () => {
  let dir: string;
  let doc: EditorDocument;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'autobeats-cross-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const conflicts = (d: EditorDocument) => findCrossLevelConflicts(d.levels, CROSS_LEVEL_EXCLUSION_MS);

  it.skipIf(!existsSync(FIXTURE))('4レベル生成 → 保存・再読込 → 書き出し・再検証 のすべてで衝突 0 件', async () => {
    const bytes = await readFile(FIXTURE);
    const decoded = decodeWav(new Uint8Array(bytes));
    const analysis = await analyzeAudio(decoded);
    const base = cmd.documentWithAudio(cmd.createEmptyDocument(), {
      token: 't'.repeat(32),
      fileName: 'song.wav',
      extension: '.wav',
      sizeBytes: bytes.length,
      mtimeMs: 0,
      sha256: await sha256File(FIXTURE),
      displayPath: FIXTURE,
      durationMs: analysis.durationMs,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels.length,
    });
    const outcome = cmd.regenerateLevels(cmd.applyAnalysis(base, analysis), LEVEL_KEYS, 'replace');
    doc = outcome.doc;
    const report = conflicts(doc);
    expect(report.total, JSON.stringify(report.countsByPair)).toBe(0);
    for (const k of LEVEL_KEYS) expect(doc.levels[k].notes.length).toBeGreaterThan(0);
    expect(cmd.summarizeIssues(cmd.findNoteIssues(doc)).hasErrors).toBe(false);

    const projectPath = path.join(dir, 'song.rhythm-project.json');
    await writeProjectFile(projectPath, buildProjectFile({ document: doc, audioPath: FIXTURE, view: null }));
    const reloaded = projectToDocument(await readProjectFile(projectPath), 't'.repeat(32), FIXTURE);
    expect(conflicts(reloaded).total).toBe(0);
    expect(reloaded.levels).toEqual(doc.levels);

    const out = path.join(dir, 'export');
    const r = await exportGamePackage(doc, FIXTURE, out, 'ask');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const verified = await verifyChartPackage(r.dir, nodePackageFs, { crossLevelExclusionMs: CROSS_LEVEL_EXCLUSION_MS });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(findCrossLevelConflicts(verified.pkg.chart.levels, CROSS_LEVEL_EXCLUSION_MS).total).toBe(0);
    expect(verified.pkg.chart.generationRules?.crossLevelExclusionMs).toBe(80);
    expect(verified.pkg.chart.levels['1'].notes.length).toBe(doc.levels['1'].notes.length);
  });

  it.skipIf(!existsSync(FIXTURE))('衝突を含む譜面は書き出せず、修復または再生成で解消できる', async () => {
    // L1 の音符を 1～3ms ずらしたコピーを L2～L4 に混ぜ、旧データと同じ状態を作る
    const l1 = doc.levels['1'].notes;
    const shifted = (k: '2' | '3' | '4', d: number): ChartNote[] => [...doc.levels[k].notes.filter((n) => !l1.some((a) => Math.abs(a.hitAtMs - n.hitAtMs) <= 400)), ...l1.map((n) => ({ ...n, id: `${n.id}-${k}`, hitAtMs: n.hitAtMs - d }))];
    const bad: EditorDocument = { ...doc, levels: { ...doc.levels, '2': { ...doc.levels['2'], notes: shifted('2', 1) }, '3': { ...doc.levels['3'], notes: shifted('3', 2) }, '4': { ...doc.levels['4'], notes: shifted('4', 3) } } };
    const before = conflicts(bad);
    expect(before.countsByPair['1-2']).toBe(l1.length);
    expect(before.total).toBeGreaterThan(l1.length * 3);
    // 読込時の検出フラグ
    expect(cmd.hasCrossLevelConflicts(bad)).toBe(true);
    const summary = cmd.summarizeIssues(cmd.findNoteIssues(bad));
    expect(summary.byCode['cross-level']).toBe(before.total);
    // 書き出し禁止（全件列挙）
    const r = await exportGamePackage(bad, FIXTURE, path.join(dir, 'export-bad'), 'ask');
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.errors.filter((e) => e.code === 'cross-level').length).toBe(before.total);
    // 修復: L1 を保持し衝突 0 件
    const repaired = cmd.repairCrossLevelConflicts(bad);
    expect(repaired.doc.levels['1'].notes).toEqual(l1);
    expect(repaired.unresolved).toBe(0);
    expect(conflicts(repaired.doc).total).toBe(0);
    expect(repaired.moved + repaired.deleted).toBeGreaterThan(0);
    const okAfterRepair = await exportGamePackage(repaired.doc, FIXTURE, path.join(dir, 'export-repaired'), 'ask');
    expect(okAfterRepair.status).toBe('ok');
    // 再生成: 衝突 0 件
    const regenerated = cmd.regenerateLevels(bad, LEVEL_KEYS, 'replace').doc;
    expect(conflicts(regenerated).total).toBe(0);
  });
});
