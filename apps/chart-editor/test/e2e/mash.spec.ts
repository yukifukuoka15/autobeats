import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, closeEditor, launchEditor, loadAudio, noteCounts, waitForWaveform } from './helpers';

const ZOOM = 60;
const Y = { ruler: 13, l1: 190, l2: 254 };
const xOf = (ms: number) => (ms / 1000) * ZOOM;

async function pixelAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    ([px, py]) => {
      const c = document.querySelector('[data-testid="timeline-canvas"]') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(Math.round(px * devicePixelRatio), Math.round(py * devicePixelRatio), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    [x, y] as const,
  );
}

test('連打: 再生中に F を押している間が連打になり、面で表示され、プレイテストで連打回数を数える', async () => {
  test.setTimeout(120000);
  const { app, page } = await launchEditor();
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    await page.getByTestId('snap-enabled').uncheck();
    const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
    // 2000ms から再生し、F を約 1 秒押し続ける
    await page.mouse.click(box.x + xOf(2000), box.y + Y.ruler);
    await page.keyboard.press('Space');
    await expect(page.getByTestId('btn-play')).toHaveAttribute('data-playing', 'true');
    await page.keyboard.down('f');
    await page.waitForTimeout(1000);
    await page.keyboard.up('f');
    await page.keyboard.press('Space');
    expect((await noteCounts(page))[0]).toBe(1);
    await expect(page.getByTestId('note-type')).toContainText('連打');
    const duration = Number(((await page.getByTestId('note-type').textContent()) ?? '').replace(/[^0-9]/g, ''));
    expect(duration).toBeGreaterThan(700);
    expect(duration).toBeLessThan(1600);
    const start = Number(await page.getByTestId('input-hit-at').inputValue());
    expect(start).toBeGreaterThan(1900);
    expect(start).toBeLessThan(2600);
    // 面（カプセル）として描かれている: 区間の中央のピクセルがレベル色（黄）で塗られている
    await page.keyboard.press('Escape');
    const [r, g, b] = await pixelAt(page, xOf(start + duration / 2), Y.l1);
    expect(r, `pixel ${r},${g},${b}`).toBeGreaterThan(60);
    expect(g).toBeGreaterThan(60);
    expect(b).toBeLessThan(60);
    // 面の中をクリックすると選択できる。長さは右パネルで変更できる
    await page.mouse.click(box.x + xOf(start + duration / 2), box.y + Y.l1);
    await expect(page.getByTestId('note-type')).toContainText('連打');
    await page.getByTestId('input-mash-duration').fill('1500');
    await page.getByTestId('input-mash-duration').press('Enter');
    await expect(page.getByTestId('note-type')).toContainText('1500ms');
    // 短い押下は連打にならない（理由を表示）
    await page.keyboard.press('Escape');
    await page.keyboard.down('f');
    await page.keyboard.up('f');
    await expect(page.getByTestId('status-text')).toContainText('連打は');
    expect((await noteCounts(page))[0]).toBe(1);
    // プレイテストで連打区間内に Q を連打すると回数が表示され、区間終了で判定される
    await page.mouse.click(box.x + xOf(Math.max(0, start - 1500)), box.y + Y.ruler);
    await page.getByTestId('btn-playtest').click();
    await page.getByTestId('btn-playtest-start').click();
    await expect(page.getByTestId('playtest')).toHaveAttribute('data-phase', 'playing', { timeout: 6000 });
    await page.waitForFunction((s) => Number(document.querySelector('[data-testid="playtest-songtime"]')?.getAttribute('data-ms') ?? 0) >= s, start + 50, { timeout: 10000 });
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('q');
      await page.waitForTimeout(150);
    }
    await expect(page.getByTestId('playtest-judge-1')).toHaveAttribute('data-kind', /MASH|PERFECT|GOOD|BAD/);
    await page.waitForFunction((s) => Number(document.querySelector('[data-testid="playtest-songtime"]')?.getAttribute('data-ms') ?? 0) >= s, start + 1500 + 400, { timeout: 10000 });
    await expect(page.getByTestId('playtest-judge-1')).toHaveAttribute('data-kind', /PERFECT|GOOD|BAD/);
    expect(Number(await page.getByTestId('playtest-score').textContent())).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
  } finally {
    await closeEditor(app);
  }
});
