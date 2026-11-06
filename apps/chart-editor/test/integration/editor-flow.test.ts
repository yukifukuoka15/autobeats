import { analyzeAudio, decodeWav, generateAllLevels } from '@autobeats/audio-analysis';
import { LEVEL_KEYS, verifyChartPackage } from '@autobeats/chart-format';
import { nodePackageFs, sha256File } from '@autobeats/chart-format/node';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportGamePackage } from '../../src/main/services/exportPackage';
import { buildProjectFile, listAutosaves, projectToDocument, readProjectFile, writeAutosave, writeProjectFile } from '../../src/main/services/project';
import { shouldApplyResult } from '../../src/renderer/src/analysis/client';
import * as cmd from '../../src/renderer/src/store/document';
import type { EditorDocument } from '../../src/shared/types';
import { findFreeTime } from '../unit/document.test';

const FIXTURE = path.resolve(__dirname, '../../../../fixtures/generated/song.wav');

describe('editor flow (WAV → 解析 → 生成 → 編集 → 保存 → 再読込 → 書き出し)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'autobeats-flow-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(FIXTURE))('完走する', async () => {
    const bytes = await readFile(FIXTURE);
    const decoded = decodeWav(new Uint8Array(bytes));
    const analysis = await analyzeAudio(decoded);
    expect(Math.abs(analysis.bpm - 120)).toBeLessThan(2);
    const sha256 = await sha256File(FIXTURE);
    let doc: EditorDocument = cmd.documentWithAudio(cmd.createEmptyDocument('independent'), {
      token: 't'.repeat(32),
      fileName: 'song.wav',
      extension: '.wav',
      sizeBytes: bytes.length,
      mtimeMs: 0,
      sha256,
      displayPath: FIXTURE,
      durationMs: analysis.durationMs,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels.length,
    });
    doc = cmd.applyAnalysis(doc, analysis);
    const generated = generateAllLevels({ analysis, choruses: doc.choruses, durationMs: analysis.durationMs });
    for (const k of LEVEL_KEYS) doc = { ...doc, levels: { ...doc.levels, [k]: { ...doc.levels[k], notes: generated[Number(k) as 1 | 2 | 3 | 4]! } } };
    expect(doc.levels['1'].notes.length).toBeGreaterThan(0);
    expect(doc.levels['4'].notes.length).toBeGreaterThan(doc.levels['1'].notes.length);
    // 編集
    const free = findFreeTime(doc, '2', 700);
    const added = cmd.addNote(doc, '2', free);
    if (!added.ok) throw new Error(added.message);
    const moved = cmd.moveNotes(added.doc, '2', new Set([added.id]), 3);
    if (!moved.ok) throw new Error(moved.message);
    doc = moved.doc;
    doc = cmd.addChorus(doc, 1000, 3000).doc;
    doc = cmd.mergeOverlappingChoruses(doc);
    // 保存 → 再読込
    const projectPath = path.join(dir, 'song.rhythm-project.json');
    await writeProjectFile(projectPath, buildProjectFile({ document: doc, audioPath: FIXTURE, view: null }));
    const reloaded = projectToDocument(await readProjectFile(projectPath), 't'.repeat(32), FIXTURE);
    expect(reloaded).toEqual(doc);
    expect(reloaded.levels['2'].notes.some((n) => n.id === added.id && n.hitAtMs === free + 3)).toBe(true);
    // 書き出し → 再検証
    const out = path.join(dir, 'export');
    const r = await exportGamePackage(doc, FIXTURE, out, 'ask');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const verified = await verifyChartPackage(r.dir, nodePackageFs);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.pkg.chart.audioSha256).toBe(sha256);
    // 自動保存 → 復旧一覧
    await writeAutosave(dir, 'project-x', projectPath, buildProjectFile({ document: doc, audioPath: FIXTURE, view: null }));
    const autosaves = await listAutosaves(dir);
    expect(autosaves).toHaveLength(1);
    expect(projectToDocument(autosaves[0]!.project, 't'.repeat(32), FIXTURE)).toEqual(doc);
  }, 120000);

  it('キャンセルした解析ジョブの結果は適用されない', async () => {
    const cancelled = new Set<number>();
    let current = 1;
    const results: number[] = [];
    const apply = (jobId: number) => {
      if (shouldApplyResult(current, jobId, cancelled)) results.push(jobId);
    };
    cancelled.add(1);
    current = 2;
    apply(1);
    apply(2);
    expect(results).toEqual([2]);
  });
});
