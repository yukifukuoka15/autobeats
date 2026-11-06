import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, closeEditor, launchEditor, loadAudio, waitForWaveform } from './helpers';

test('異なる難易度で同時刻に追加・ドラッグ・数値入力できる', async () => {
  const { app, page } = await launchEditor();
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    await page.getByTestId('snap-enabled').uncheck();
    const box = await page.getByTestId('timeline-canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    await page.mouse.dblclick(box.x + 120, box.y + 190);
    await page.mouse.dblclick(box.x + 120, box.y + 254);
    await expect(page.getByTestId('input-hit-at')).toHaveValue('2000');
    await expect(page.getByTestId('count-2')).toHaveText('L2: 1');
    await page.getByTestId('input-hit-at').fill('4000');
    await page.getByTestId('input-hit-at').press('Enter');
    await page.mouse.move(box.x + 240, box.y + 254);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 254, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId('input-hit-at')).toHaveValue('2000');
    await page.getByTestId('input-hit-at').fill('2080');
    await page.getByTestId('input-hit-at').press('Enter');
    await expect(page.getByTestId('input-hit-at')).toHaveValue('2080');
    await expect(page.getByTestId('issues-none')).toBeVisible();
  } finally { await closeEditor(app); }
});
