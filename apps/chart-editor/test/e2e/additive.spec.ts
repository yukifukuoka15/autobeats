import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ChartFile } from '@autobeats/chart-format';
import { FIXTURES, analyze, closeEditor, launchEditor, loadAudio, stubOpenDialog, stubSaveDialog, waitForWaveform } from './helpers';

async function exportJson(app: ElectronApplication, page: Page, file: string): Promise<ChartFile> {
  await stubSaveDialog(app, file);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:action', 'exportJson'));
  await expect(page.getByTestId('dialog-export-result')).toContainText('書き出しました');
  await page.getByTestId('dialog-ok').click();
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('空のLv1を作成し、追加分生成・Lv1保護・モードの保存再読込ができる', async () => {
  const { app, page } = await launchEditor();
  const dir = mkdtempSync(path.join(tmpdir(), 'autobeats-additive-'));
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    await expect(page.getByTestId('additive-mode')).toBeChecked();
    await expect(page.getByTestId('count-4')).toHaveCount(0);
    await analyze(page);
    const before = await exportJson(app, page, path.join(dir, 'before.json'));
    for (const k of ['1', '2', '3'] as const) expect(before.levels[k].notes.length).toBeGreaterThan(0);
    expect(before.levels['4'].notes).toHaveLength(0);
    expect(before.generationRules?.noteMode).toBe('additive');
    await page.getByTestId('generate-additions').click();
    await page.locator('#keep-manual').uncheck();
    await page.getByTestId('regen-all').click();
    const after = await exportJson(app, page, path.join(dir, 'after.json'));
    expect(after.levels['1']).toEqual(before.levels['1']);
    const project = path.join(dir, 'test.rhythm-project.json');
    await stubSaveDialog(app, project);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:action', 'save'));
    await expect(page.getByTestId('dirty-indicator')).not.toContainText('未保存');
    expect(JSON.parse(readFileSync(project, 'utf8')).noteMode).toBe('additive');
    await stubOpenDialog(app, project);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:action', 'open'));
    await expect(page.getByTestId('additive-mode')).toBeChecked();
    await expect(page.getByTestId('issues-none')).toBeVisible();
    if (process.env.ADDITIVE_SCREENSHOT) await page.screenshot({ path: process.env.ADDITIVE_SCREENSHOT });
  } finally { await closeEditor(app); }
});
