import { expect, test } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FIXTURES, analyze, closeEditor, launchEditor, loadAudio, noteCounts, stubMessageBox, stubSaveDialog, waitForWaveform } from './helpers';

test('ライブラリ: 読み込んだ楽曲がアプリ内に保存され、一覧から再度開け、削除できる', async () => {
  test.setTimeout(180000);
  const work = mkdtempSync(path.join(tmpdir(), 'autobeats-lib-e2e-'));
  const first = await launchEditor();
  const userData = first.userData;
  let app = first.app;
  let page = first.page;
  let counts: number[];
  try {
    await expect(page.getByTestId('library')).toContainText('ライブラリ（0）');
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    // 読み込んだ時点で音声がアプリ内（userData/library/<id>/audio.wav）へコピーされる
    await expect(page.getByTestId('library')).toContainText('ライブラリ（1）');
    const libDir = path.join(userData, 'library');
    const ids = readdirSync(libDir).filter((n) => /^[0-9a-f]{16}$/.test(n));
    expect(ids).toHaveLength(1);
    expect(existsSync(path.join(libDir, ids[0]!, 'audio.wav'))).toBe(true);
    await expect(page.getByTestId('library-entry')).toContainText('譜面なし');
    await expect(page.getByTestId('library-open')).toBeDisabled(); // 編集中
    // 解析して保存すると譜面データも保存され、一覧に音符数が出る
    await analyze(page);
    counts = await noteCounts(page);
    await stubSaveDialog(app, path.join(work, 'song.rhythm-project.json'));
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('dirty-indicator')).toContainText('保存済み');
    await expect(page.getByTestId('library-entry')).toContainText(`L1 ${counts[0]} L2 ${counts[1]} L3 ${counts[2]} L4 ${counts[3]}`);
    expect(existsSync(path.join(libDir, ids[0]!, 'project.json'))).toBe(true);
  } finally {
    await closeEditor(app);
  }

  // 再起動しても一覧が残り、「開く」で音声と譜面が戻る（元ファイルがなくてもライブラリのコピーを使う）
  ({ app, page } = await launchEditor(userData));
  try {
    await expect(page.getByTestId('library')).toContainText('ライブラリ（1）');
    await page.getByTestId('library-open').click();
    await page.getByTestId('audio-duration').waitFor({ timeout: 60000 });
    await waitForWaveform(page);
    expect(await noteCounts(page)).toEqual(counts!);
    await expect(page.getByTestId('library-open')).toBeDisabled();
    // 削除（確認ダイアログで「削除」）
    await stubMessageBox(app, 0);
    await page.getByTestId('library-remove').click();
    await expect(page.getByTestId('library')).toContainText('ライブラリ（0）');
    expect(readdirSync(path.join(userData, 'library')).filter((n) => /^[0-9a-f]{16}$/.test(n))).toHaveLength(0);
    // 元の音声ファイルは残っている
    expect(existsSync(path.join(FIXTURES, 'song.wav'))).toBe(true);
  } finally {
    await closeEditor(app);
  }
});
