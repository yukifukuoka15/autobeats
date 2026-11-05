import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, closeEditor, launchEditor, loadAudio, waitForWaveform } from './helpers';

const ZOOM = 60;
const Y = { ruler: 13, l1: 190, l2: 254 };
const xOf = (ms: number) => (ms / 1000) * ZOOM;

test('プレイテスト: Q/W/O/P で 4 レーンを試奏し、判定・スコア・結果が表示され、Esc で停止する', async () => {
  test.setTimeout(120000);
  const { app, page } = await launchEditor();
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    await page.getByTestId('snap-enabled').uncheck();
    const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
    // L1 に 4000ms と 8000ms、L2 に 6000ms のヒットを置く
    await page.mouse.dblclick(box.x + xOf(4000), box.y + Y.l1);
    await page.mouse.dblclick(box.x + xOf(8000), box.y + Y.l1);
    await page.mouse.dblclick(box.x + xOf(6000), box.y + Y.l2);
    await page.mouse.click(box.x + xOf(2000), box.y + Y.ruler); // 2000ms から開始
    await page.getByTestId('btn-playtest').click();
    await expect(page.getByTestId('playtest')).toHaveAttribute('data-phase', 'ready');
    await expect(page.getByTestId('playtest-lane-1')).toContainText('Q');
    await expect(page.getByTestId('playtest-lane-4')).toContainText('P');
    await page.getByTestId('btn-playtest-start').click();
    await expect(page.getByTestId('playtest')).toHaveAttribute('data-phase', 'countdown');
    await expect(page.getByTestId('playtest-countdown')).toBeVisible();
    await expect(page.getByTestId('playtest')).toHaveAttribute('data-phase', 'playing', { timeout: 6000 });
    // 空押し（W を関係ない時刻に）
    await page.keyboard.press('w');
    await expect(page.getByTestId('playtest-judge-2')).toHaveAttribute('data-kind', 'EMPTY');
    // 4000ms の音符を Q で叩く（表示時刻を見て押す）
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="playtest-songtime"]')?.getAttribute('data-ms') ?? 0) >= 3960, null, { timeout: 10000 });
    await page.keyboard.press('q');
    await expect(page.getByTestId('playtest-judge-1')).toHaveAttribute('data-kind', /PERFECT|GOOD|BAD/);
    const score = Number(await page.getByTestId('playtest-score').textContent());
    expect(score).toBeGreaterThan(0);
    // 6000ms のヒットは押さずに MISS
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="playtest-songtime"]')?.getAttribute('data-ms') ?? 0) >= 6300, null, { timeout: 10000 });
    await expect(page.getByTestId('playtest-counts')).toContainText(/\/ 1 \/ \d+$/);
    // LEVEL 1 はスペースキーでも反応する（8000ms のヒット）
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="playtest-songtime"]')?.getAttribute('data-ms') ?? 0) >= 7960, null, { timeout: 10000 });
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playtest-judge-1')).toHaveAttribute('data-kind', /PERFECT|GOOD|BAD/);
    await expect(page.getByTestId('playtest-counts')).not.toContainText(/^0 \/ 0 \/ 0/);
    expect(Number(await page.getByTestId('playtest-score').textContent())).toBeGreaterThan(score);
    // Esc で中止 → エディターへ戻り、再生は止まり、未保存状態・音符は変わらない
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('playtest')).toHaveCount(0);
    await expect(page.getByTestId('btn-play')).toHaveAttribute('data-playing', 'false');
    await expect(page.getByTestId('count-1')).toHaveText('L1: 2');
    await expect(page.getByTestId('count-2')).toHaveText('L2: 1');
    // 通常ショートカットが復帰している（Space で再生）
    await page.keyboard.press('Space');
    await expect(page.getByTestId('btn-play')).toHaveAttribute('data-playing', 'true');
    await page.keyboard.press('Space');
  } finally {
    await closeEditor(app);
  }
});
