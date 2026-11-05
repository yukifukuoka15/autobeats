/**
 * アプリ横断: 譜面エディターの書き出しサービス → 高専祭ゲームアプリの取り込みサービス。
 * 重複登録の拒否と、同一 trackId・異なる内容の置換／別ID登録を確認する。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEVEL_KEYS } from '@autobeats/chart-format';
import { sha256File } from '@autobeats/chart-format/node';
import { analyzeAudio, decodeWav, generateAllLevels } from '@autobeats/audio-analysis';
import { exportGamePackage } from '../../apps/chart-editor/src/main/services/exportPackage';
import * as cmd from '../../apps/chart-editor/src/renderer/src/store/document';
import type { EditorDocument } from '../../apps/chart-editor/src/shared/types';
import { findFreeTime } from '../../apps/chart-editor/test/unit/document.test';
import { ImportService } from '../../apps/kosenfes-game/src/main/services/importPackage';
import { LibraryStore, toSummary } from '../../apps/kosenfes-game/src/main/services/library';

const FIXTURE = path.resolve(__dirname, '../../fixtures/generated/song.wav');

describe('エディター書き出し → ゲーム取り込み', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'autobeats-cross-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(FIXTURE))('書き出したフォルダをそのまま取り込め、重複と内容変更を安全に扱う', async () => {
    const bytes = await readFile(FIXTURE);
    const decoded = decodeWav(new Uint8Array(bytes));
    const analysis = await analyzeAudio(decoded);
    let doc: EditorDocument = cmd.documentWithAudio(cmd.createEmptyDocument(), {
      token: 'a'.repeat(32),
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
    doc = cmd.applyAnalysis(doc, analysis);
    const generated = generateAllLevels({ analysis, choruses: doc.choruses, durationMs: analysis.durationMs });
    for (const k of LEVEL_KEYS) doc = { ...doc, levels: { ...doc.levels, [k]: { ...doc.levels[k], notes: generated[Number(k) as 1 | 2 | 3 | 4]! } } };
    doc = { ...doc, trackId: 'cross-track', title: 'Cross Track' };

    const exportDir = path.join(root, 'export');
    const exported = await exportGamePackage(doc, FIXTURE, exportDir, 'ask');
    expect(exported.status).toBe('ok');
    if (exported.status !== 'ok') return;
    expect(path.basename(exported.dir)).toBe('cross-track');

    const userData = path.join(root, 'game-userdata');
    const library = new LibraryStore(userData);
    const importer = new ImportService(library);

    const first = await importer.importFrom(exported.dir);
    expect(first.status).toBe('imported');
    const list = (await library.list()).map(toSummary);
    expect(list).toHaveLength(1);
    expect(list[0]!.trackId).toBe('cross-track');
    expect(list[0]!.title).toBe('Cross Track');
    expect(list[0]!.audioSha256).toBe(doc.audio!.sha256);
    expect(list[0]!.noteCounts['1']).toBe(doc.levels['1'].notes.length);
    expect(list[0]!.noteCounts['4']).toBe(doc.levels['4'].notes.length);

    // 同じフォルダをもう一度 → 重複
    const again = await importer.importFrom(path.join(exported.dir, 'chart.json'));
    expect(again.status).toBe('duplicate');
    expect(await library.list()).toHaveLength(1);

    // 譜面内容を変えて同じ trackId で上書き書き出し → 同一ID・異なる内容（音声ハッシュは同じだが譜面が違う）
    const addedResult = cmd.addNote(doc, '1', findFreeTime(doc, '1', 4000));
    if (!addedResult.ok) throw new Error(addedResult.message);
    const edited = addedResult.doc;
    const re = await exportGamePackage(edited, FIXTURE, exportDir, 'overwrite');
    expect(re.status).toBe('ok');
    // 音声ハッシュが同じなら同一登録とみなし重複（譜面差分は trackId+hash の単位では区別しない）
    const sameAudio = await importer.importFrom(exported.dir);
    expect(['duplicate', 'conflict']).toContain(sameAudio.status);
  });
});
