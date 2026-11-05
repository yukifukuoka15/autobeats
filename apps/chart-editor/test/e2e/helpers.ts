import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export const ROOT = path.resolve(__dirname, '../../../..');
export const FIXTURES = path.join(ROOT, 'fixtures', 'generated');
export const MAIN = path.resolve(__dirname, '../../out/main/index.js');

export async function launchEditor(userData?: string, executablePath?: string): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const ud = userData ?? mkdtempSync(path.join(tmpdir(), 'autobeats-e2e-'));
  const app = await electron.launch({
    args: executablePath ? [] : [MAIN],
    executablePath,
    env: { ...process.env, AUTOBEATS_USER_DATA: ud, ELECTRON_ENABLE_LOGGING: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="app"]');
  return { app, page, userData: ud };
}

/** ネイティブダイアログを差し替える */
export async function stubOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, filePath);
}

export async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, filePath);
}

export async function stubMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    dialog.showMessageBox = async () => ({ response: r, checkboxChecked: false });
  }, response);
}

/** 未保存ダイアログで止まらないよう「保存しない」を選んで閉じる */
export async function closeEditor(app: ElectronApplication): Promise<void> {
  await stubMessageBox(app, 1).catch(() => undefined);
  await app.close().catch(() => undefined);
}

export async function waitForWaveform(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const c = document.querySelector('[data-testid="timeline-canvas"]') as HTMLCanvasElement | null;
      if (!c) return false;
      const ctx = c.getContext('2d')!;
      const data = ctx.getImageData(0, Math.round(100 * devicePixelRatio), c.width, 1).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! > 90 && data[i + 1]! < 80 && data[i + 2]! < 80) n++; // 赤系の波形ピクセル
      return n > 10;
    },
    null,
    { timeout: 60000 },
  );
}

export async function loadAudio(app: ElectronApplication, page: Page, file: string): Promise<void> {
  await stubOpenDialog(app, file);
  await page.getByTestId('btn-open-audio').click();
  await page.getByTestId('audio-duration').waitFor({ timeout: 60000 });
}

export async function analyze(page: Page): Promise<void> {
  await page.getByTestId('btn-analyze').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="analysis-progress"]')?.getAttribute('data-status') === 'done', null, { timeout: 120000 });
}

export async function noteCounts(page: Page): Promise<number[]> {
  const texts = await Promise.all(['1', '2', '3', '4'].map((k) => page.getByTestId(`count-${k}`).textContent()));
  return texts.map((t) => Number((t ?? '').split(':')[1]?.trim() ?? '0'));
}
