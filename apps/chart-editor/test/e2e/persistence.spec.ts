import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FIXTURES, analyze, closeEditor, launchEditor, loadAudio, noteCounts, stubMessageBox, stubOpenDialog, stubSaveDialog, waitForWaveform } from './helpers';

test('保存 → 再起動 → 再読込で編集内容が一致し、書き出しの失敗と成功を確認できる', async () => {
  test.setTimeout(240000);
  const work = mkdtempSync(path.join(tmpdir(), 'autobeats-persist-'));
  const projectPath = path.join(work, 'song.rhythm-project.json');
  const first = await launchEditor();
  const userData = first.userData;
  let app = first.app;
  let page = first.page;
  let counts: number[];
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.mp3'));
    await waitForWaveform(page);
    await analyze(page);
    await page.getByTestId('snap-enabled').uncheck();
    const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
    await page.getByTestId('btn-activate-2').click();
    // 曲頭の無音区間（他レベルの音符から 80ms を超えて離れた位置）へシークして手作業音符を置く
    await page.mouse.click(box.x + 60 * 0.25, box.y + 13); // 250ms へシーク
    await page.keyboard.press('n'); // L2 の再生ヘッド位置へ手作業音符
    await page.getByTestId('input-title').fill('テスト曲');
    counts = await noteCounts(page);
    await stubSaveDialog(app, projectPath);
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('dirty-indicator')).toContainText('保存済み');
    await expect(page.getByTestId('project-name')).toContainText('song');
    expect(existsSync(projectPath)).toBe(true);
    const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
    expect(saved.format).toBe('autobeats-rhythm-project');
    expect(saved.levels['2'].notes.some((n: { source: string; hitAtMs: number }) => n.source === 'manual' && n.hitAtMs === 250)).toBe(true);
  } finally {
    await closeEditor(app);
  }

  ({ app, page } = await launchEditor(userData));
  try {
    await stubOpenDialog(app, projectPath);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:action', 'open'));
    await expect(page.getByTestId('project-name')).toContainText('song', { timeout: 30000 });
    await page.getByTestId('audio-duration').waitFor({ timeout: 60000 });
    await waitForWaveform(page);
    expect(await noteCounts(page)).toEqual(counts);
    await expect(page.getByTestId('input-title')).toHaveValue('テスト曲');
    await expect(page.getByTestId('dirty-indicator')).toContainText('保存済み');

    // 書き出し: 重なるサビ区間を作ってエラー
    await page.getByTestId('snap-enabled').uncheck();
    const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
    // 既存サビの上に重ねて追加できないので、空き位置に 2 つ作ってから数値入力で重ねる
    await page.getByTestId('timeline-canvas').click({ position: { x: 30, y: 100 } }); // 0.5s へシーク
    await page.mouse.move(box.x + 60 * 1, box.y + 35);
    await page.mouse.down();
    await page.mouse.move(box.x + 60 * 4, box.y + 35, { steps: 8 });
    await page.mouse.up();
    // 解析済みなので再生成ダイアログ → 維持
    const regen = page.getByTestId('dialog-regenerate');
    if (await regen.count()) await page.getByTestId('regen-keep').click();
    await page.getByTestId('input-chorus-end').fill('60000');
    await page.getByTestId('input-chorus-end').press('Enter');
    await expect(page.getByTestId('dialog-overlap')).toBeVisible();
    await page.getByRole('button', { name: 'キャンセル（手動で修正）' }).click();
    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('dialog-overlap')).toBeVisible();
    await page.getByTestId('overlap-merge').click();

    // 正常に書き出し
    const exportDir = path.join(work, 'export');
    await stubOpenDialog(app, exportDir);
    await stubMessageBox(app, 0);
    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('dialog-export-result')).toContainText('再検証が完了', { timeout: 60000 });
    await page.getByTestId('dialog-ok').click();
    const pkg = path.join(exportDir, 'song');
    expect(existsSync(path.join(pkg, 'chart.json'))).toBe(true);
    expect(existsSync(path.join(pkg, 'audio.mp3'))).toBe(true);
    const chart = JSON.parse(readFileSync(path.join(pkg, 'chart.json'), 'utf8'));
    expect(chart.format).toBe('kosen-rhythm-chart');
    expect(chart.levels['2'].notes.length).toBe(counts[1]);
    // 同名フォルダがあるので「別名」
    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('dialog-export-exists')).toBeVisible();
    await page.getByTestId('export-rename').click();
    await expect(page.getByTestId('dialog-export-result')).toContainText('song (2)');
    await page.getByTestId('dialog-ok').click();
    // 書き出したフォルダの再検証
    await stubOpenDialog(app, pkg);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:action', 'verifyPackage'));
    await expect(page.getByTestId('dialog-verify-result')).toContainText('検証に成功');
    await expect(page.getByTestId('verify-import')).toBeVisible();
    await page.getByTestId('dialog-ok').click();
  } finally {
    await closeEditor(app);
  }
});

test('自動保存からの復旧候補が次回起動時に表示される', async () => {
  const { app, page, userData } = await launchEditor();
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'click120.wav'));
    await page.getByTestId('snap-enabled').uncheck();
    const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
    await page.mouse.dblclick(box.x + 60 * 2, box.y + 190);
    // 自動保存は 5 秒デバウンス
    await expect(page.getByTestId('status-text')).toContainText('自動保存', { timeout: 20000 });
  } finally {
    // 保存せず強制終了相当（保存しないで閉じる）
    await closeEditor(app);
  }
  const second = await launchEditor(userData);
  try {
    await expect(second.page.getByTestId('dialog-recovery')).toBeVisible({ timeout: 15000 });
    await expect(second.page.getByTestId('recovery-entry')).toHaveCount(1);
    await second.page.getByTestId('recovery-open').click();
    await second.page.getByTestId('audio-duration').waitFor({ timeout: 60000 });
    expect((await noteCounts(second.page))[0]).toBe(1);
    await expect(second.page.getByTestId('dirty-indicator')).toContainText('未保存');
  } finally {
    await closeEditor(second.app);
  }
});
