import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as cmd from '../../src/renderer/src/store/document';
import { addRecent, autosaveKey, buildProjectFile, listAutosaves, parseProjectText, projectToDocument, readProjectFile, readRecentList, removeAutosave, writeAutosave, writeProjectFile } from '../../src/main/services/project';
import { audioMeta, findFreeTime, syntheticAnalysis } from './document.test';

describe('project file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'autobeats-project-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ドキュメント → ファイル → ドキュメントを往復できる', async () => {
    let doc = cmd.documentWithAudio(cmd.createEmptyDocument('independent'), audioMeta);
    doc = cmd.regenerateLevels(cmd.applyAnalysis(doc, syntheticAnalysis()), ['1', '2', '3', '4'], 'replace').doc;
    const added = cmd.addNote(doc, '3', findFreeTime(doc, '3', 4000));
    if (!added.ok) throw new Error(added.message);
    doc = added.doc;
    const file = buildProjectFile({ document: doc, audioPath: '/tmp/song.wav', view: null });
    const p = path.join(dir, 'x.rhythm-project.json');
    await writeProjectFile(p, file);
    const read = await readProjectFile(p);
    expect(read.audio?.path).toBe('/tmp/song.wav');
    const back = projectToDocument(read, audioMeta.token, audioMeta.displayPath);
    expect(back).toEqual(doc);
  });

  it('不正な JSON・別形式・未知バージョンを日本語で拒否する', () => {
    expect(() => parseProjectText('{nope')).toThrow('JSON');
    expect(() => parseProjectText(JSON.stringify({ format: 'other', formatVersion: 1 }))).toThrow('プロジェクトファイルではありません');
    expect(() => parseProjectText(JSON.stringify({ format: 'autobeats-rhythm-project', formatVersion: 99 }))).toThrow('非対応');
    expect(() => parseProjectText(JSON.stringify({ format: 'autobeats-rhythm-project', formatVersion: 1, title: 1 }))).toThrow('構造が不正');
  });

  it('最近使ったプロジェクトは存在しないファイルを除外する', async () => {
    const a = path.join(dir, 'a.rhythm-project.json');
    const b = path.join(dir, 'b.rhythm-project.json');
    await writeFile(a, '{}');
    await writeFile(b, '{}');
    await addRecent(dir, a);
    await addRecent(dir, b);
    expect((await readRecentList(dir)).map((r) => r.path)).toEqual([b, a]);
    await rm(a);
    expect((await readRecentList(dir)).map((r) => r.path)).toEqual([b]);
  });

  it('自動保存を書き、一覧し、削除できる', async () => {
    const doc = cmd.documentWithAudio(cmd.createEmptyDocument('independent'), audioMeta);
    const file = buildProjectFile({ document: doc, audioPath: '/tmp/song.wav', view: null });
    const key = autosaveKey('/some/project.rhythm-project.json', 'sess');
    expect(autosaveKey(null, 'sess')).toBe('unsaved-sess');
    expect(key).toMatch(/^project-[0-9a-f]+$/);
    const written = await writeAutosave(dir, key, '/some/project.rhythm-project.json', file);
    await writeFile(path.join(dir, 'autosave', 'broken.json'), '{broken');
    const list = await listAutosaves(dir);
    expect(list).toHaveLength(1);
    expect(list[0]!.originalPath).toBe('/some/project.rhythm-project.json');
    expect(list[0]!.project.trackId).toBe('song');
    await expect(removeAutosave('/etc/passwd', dir)).rejects.toThrow();
    await removeAutosave(written, dir);
    expect(await listAutosaves(dir)).toHaveLength(0);
  });
});
