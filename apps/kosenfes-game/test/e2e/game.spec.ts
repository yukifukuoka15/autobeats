import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writeTestPackage } from '../helpers/package';

const MAIN = path.resolve(__dirname, '../../out/main/index.js');

let userData: string;
let pkgDir: string;
let app: ElectronApplication;
let page: Page;
const NOTES = [3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'kosenfes-e2e-'));
  pkgDir = path.join(userData, 'pkg');
  await writeTestPackage(pkgDir, { trackId: 'e2e-track', title: 'E2E テスト曲', durationSec: 8, notes: { '1': NOTES, '2': NOTES, '3': NOTES, '4': NOTES } });
  app = await electron.launch({ args: [MAIN], env: { ...process.env, KOSENFES_USER_DATA: userData } });
  page = await app.firstWindow();
  await page.waitForSelector('[data-testid="tab-admin"]');
});

test.afterAll(async () => {
  await app?.close();
  await rm(userData, { recursive: true, force: true });
});

async function stubOpenDialog(target: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, target);
}

test('楽曲を選択せずに開始しようとすると日本語の理由が出る', async () => {
  await page.getByTestId('tab-game').click();
  await expect(page.getByTestId('start-reasons')).toContainText('楽曲が選択されていません');
  await expect(page.getByTestId('start-button')).toBeDisabled();
});

test('フォルダを取り込み、重複は拒否される', async () => {
  await page.getByTestId('tab-admin').click();
  await stubOpenDialog(pkgDir);
  await page.getByTestId('import-folder').click();
  await expect(page.getByTestId('admin-message')).toContainText('取り込みました');
  await expect(page.getByTestId('track-e2e-track')).toContainText('E2E テスト曲');
  await expect(page.getByTestId('track-e2e-track')).toContainText('OK');
  await page.getByTestId('import-folder').click();
  await expect(page.getByTestId('admin-message')).toContainText('すでに登録されています');
});

test('曲・LEVEL・仮想デバイスを選び、キーボードで最後までプレイして登録できる', async () => {
  await page.getByTestId('select-e2e-track').click();
  await page.getByTestId('level-select').selectOption('2');
  await page.getByTestId('device-select').selectOption('virtual-keyboard');
  await page.getByTestId('tab-game').click();
  await expect(page.getByTestId('game-title')).toContainText('E2E テスト曲 / LEVEL 2');
  await expect(page.getByTestId('start-button')).toBeEnabled({ timeout: 15000 });
  await page.getByTestId('start-button').click();
  await expect(page.getByTestId('game-screen')).toHaveAttribute('data-phase', 'countdown');
  await expect(page.getByTestId('game-screen')).toHaveAttribute('data-phase', 'playing', { timeout: 8000 });

  // 実際のキーボード → preload IPC → 仮想デバイス → main 判定 の経路で押す。
  // 楽曲時刻は main のスナップショットから取る（各音符の直前まで待ってから押す）。
  const songTime = () => page.evaluate(() => window.kosenfes.game.snapshot().then((s) => s?.songTimeMs ?? -1));
  for (const hit of NOTES) {
    while ((await songTime()) < hit - 40) await page.waitForTimeout(5);
    await page.keyboard.down('Space');
    await page.waitForTimeout(30);
    await page.keyboard.up('Space');
  }
  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 10000 });
  const perfect = Number(await page.getByTestId('count-perfect').textContent());
  const good = Number(await page.getByTestId('count-good').textContent());
  const bad = Number(await page.getByTestId('count-bad').textContent());
  const miss = Number(await page.getByTestId('count-miss').textContent());
  expect(perfect + good + bad + miss).toBe(NOTES.length);
  expect(perfect + good).toBeGreaterThanOrEqual(NOTES.length - 2);
  const score = Number(await page.getByTestId('result-score').textContent());
  expect(score).toBeGreaterThan(0);
  await expect(page.getByTestId('provisional-rank')).toContainText('1 位');
  await page.getByTestId('name-input').fill('テスター');
  await page.getByTestId('register-button').click();
  await expect(page.getByTestId('registered-message')).toContainText('登録しました');

  const rankings = JSON.parse(await readFile(path.join(userData, 'rankings.json'), 'utf8')) as { rankings: Record<string, { name: string; score: number }[]> };
  const keys = Object.keys(rankings.rankings);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(/^neon-hit:song:e2e-track:[0-9a-f]{64}:v1:L2$/);
  expect(rankings.rankings[keys[0]!]![0]).toMatchObject({ name: 'テスター', score });

  await page.getByTestId('tab-admin').click();
  await expect(page.getByTestId('ranking-table')).toContainText('テスター');
});

test('固定譜面モードも開始・中断できる（既存モードの回帰確認）', async () => {
  await page.getByTestId('tab-admin').click();
  await page.getByTestId('mode-select').selectOption('fixed');
  await page.getByTestId('tab-game').click();
  await expect(page.getByTestId('game-title')).toContainText('固定譜面');
  await expect(page.getByTestId('start-button')).toBeEnabled({ timeout: 15000 });
  await page.getByTestId('start-button').click();
  await expect(page.getByTestId('game-screen')).toHaveAttribute('data-phase', 'playing', { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.getByTestId('abort-button').click();
  await expect(page.getByTestId('result-screen')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('abort-message')).toContainText('ランキング対象外');
});

test('プレイ中でない楽曲は確認後に削除できる', async () => {
  await page.getByTestId('tab-admin').click();
  await page.getByTestId('delete-e2e-track').click();
  await expect(page.getByTestId('delete-dialog')).toBeVisible();
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('admin-message')).toContainText('削除しました');
  await expect(page.getByTestId('track-e2e-track')).toHaveCount(0);
});
