import { sha256Buffer } from '@autobeats/chart-format/node';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectAudioFile } from '../../src/main/services/audioFile';
import { EditorLibrary, libraryIdFor } from '../../src/main/services/library';
import { buildProjectFile } from '../../src/main/services/project';
import * as cmd from '../../src/renderer/src/store/document';
import { audioMeta, findFreeTime } from './document.test';

describe('EditorLibrary', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'autobeats-lib-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('読み込んだ音声をアプリ内へコピーし、同じ音声は 1 件にまとめ、譜面データと一覧情報を更新・削除できる', async () => {
    const bytes = new Uint8Array(4000).map((_, i) => (i * 7) % 256);
    const src = path.join(root, 'original.wav');
    await writeFile(src, bytes);
    const info = await inspectAudioFile(src);
    const lib = new EditorLibrary(path.join(root, 'userdata'));
    const first = await lib.importAudio(info);
    expect(first.created).toBe(true);
    expect(first.entry.id).toBe(libraryIdFor(info.sha256));
    expect(await readFile(first.audioPath)).toEqual(await readFile(src)); // バイト列コピー
    expect(first.audioPath.startsWith(lib.dir)).toBe(true);
    // 原本は変更されない
    expect(sha256Buffer(await readFile(src))).toBe(info.sha256);
    // 同じ音声を別名で読み込んでも 1 件
    const copy = path.join(root, 'renamed.wav');
    await writeFile(copy, bytes);
    const second = await lib.importAudio(await inspectAudioFile(copy));
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect((await lib.list()).length).toBe(1);
    expect((await lib.list())[0]!.fileName).toBe('renamed.wav');
    expect((await lib.list())[0]!.hasProject).toBe(false);
    // 譜面データの保存で一覧情報が更新される
    let doc = cmd.documentWithAudio(cmd.createEmptyDocument(), { ...audioMeta, sha256: info.sha256, fileName: 'original.wav', durationMs: 30000 });
    doc = { ...doc, title: 'テスト曲', bpm: 128 };
    const add = cmd.addNote(doc, '1', findFreeTime(doc, '1'));
    if (!add.ok) throw new Error(add.message);
    doc = add.doc;
    const saved = await lib.saveProject(first.entry.id, buildProjectFile({ document: doc, audioPath: first.audioPath, view: null }));
    expect(saved).toMatchObject({ title: 'テスト曲', bpm: 128, hasProject: true, durationMs: 30000, noteCounts: { '1': 1, '2': 0, '3': 0, '4': 0 } });
    const project = await lib.readProject(first.entry.id);
    expect(project?.levels['1'].notes.length).toBe(1);
    expect(project?.audio?.path).toBe(first.audioPath);
    expect(await lib.audioPath(first.entry.id)).toBe(first.audioPath);
    // 未登録 id の保存は無視
    expect(await lib.saveProject('0000000000000000', project!)).toBeNull();
    // 削除（原本は残る）
    expect(await lib.remove(first.entry.id)).toBe(true);
    expect(await lib.list()).toHaveLength(0);
    expect(await lib.audioPath(first.entry.id)).toBeNull();
    expect(await readFile(src)).toEqual(Buffer.from(bytes));
    expect(await lib.remove(first.entry.id)).toBe(false);
  });

  it('壊れた索引は退避して空から再構築する', async () => {
    const lib = new EditorLibrary(path.join(root, 'ud'));
    await writeFile(path.join(root, 'ud'), '', { flag: 'a' }).catch(() => undefined);
    await rm(path.join(root, 'ud'), { force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(lib.dir, { recursive: true });
    await writeFile(path.join(lib.dir, 'index.json'), '{broken');
    expect(await lib.list()).toEqual([]);
  });
});
