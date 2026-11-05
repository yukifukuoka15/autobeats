import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, closeEditor, launchEditor, loadAudio, noteCounts, waitForWaveform } from './helpers';

/** 既定ズーム 60px/s・スクロール 0 のときの楽曲時刻 → キャンバス座標 */
async function canvasOrigin(page: Page) {
  const box = await page.getByTestId('timeline-canvas').boundingBox();
  if (!box) throw new Error('canvas not found');
  return box;
}
const ZOOM = 60; // px/s
const Y = { ruler: 13, chorus: 35, wave: 100, l1: 190, l2: 254, l3: 318, l4: 382 };
const xOf = (ms: number) => (ms / 1000) * ZOOM;

async function setup() {
  const r = await launchEditor();
  await loadAudio(r.app, r.page, path.join(FIXTURES, 'song.wav'));
  await waitForWaveform(r.page);
  await r.page.getByTestId('snap-enabled').uncheck();
  return r;
}

test('音符の追加・ドラッグ移動・複数選択・削除・Undo・Redo', async () => {
  const { app, page } = await setup();
  try {
    const box = await canvasOrigin(page);
    await page.mouse.dblclick(box.x + xOf(2000), box.y + Y.l1);
    expect((await noteCounts(page))[0]).toBe(1);
    await expect(page.getByTestId('input-hit-at')).toHaveValue('2000');
    await expect(page.getByTestId('note-reason')).toHaveText('manual');
    // ドラッグ移動 2000 → 3000ms
    await page.mouse.move(box.x + xOf(2000), box.y + Y.l1);
    await page.mouse.down();
    await page.mouse.move(box.x + xOf(2500), box.y + Y.l1, { steps: 5 });
    await page.mouse.move(box.x + xOf(3000), box.y + Y.l1, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('input-hit-at')).toHaveValue('3000');
    // 右パネルで数値入力
    await page.getByTestId('input-hit-at').fill('3456');
    await page.getByTestId('input-hit-at').press('Enter');
    await expect(page.getByTestId('input-hit-at')).toHaveValue('3456');
    // 2つ目・3つ目
    await page.mouse.dblclick(box.x + xOf(5000), box.y + Y.l1);
    await page.mouse.dblclick(box.x + xOf(7000), box.y + Y.l1);
    expect((await noteCounts(page))[0]).toBe(3);
    // 矩形選択（空き位置からドラッグ）
    await page.mouse.move(box.x + xOf(4000), box.y + Y.l1 - 20);
    await page.mouse.down();
    await page.mouse.move(box.x + xOf(8000), box.y + Y.l1 + 20, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId('selected-count')).toHaveText('2');
    // Shift クリックで追加選択
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + xOf(3456), box.y + Y.l1);
    await page.keyboard.up('Shift');
    await expect(page.getByTestId('selected-count')).toHaveText('3');
    // 一括移動（Command+Shift+矢印 ×10ms。矢印単体は再生ヘッドのスクラブ）
    await page.keyboard.press('Meta+Shift+ArrowRight');
    await expect(page.getByTestId('issues-none')).toBeVisible();
    // 全選択 → 削除
    await page.keyboard.press('Escape');
    await page.mouse.dblclick(box.x + xOf(9000), box.y + Y.l1);
    expect((await noteCounts(page))[0]).toBe(4);
    await page.keyboard.press('Meta+a');
    await expect(page.getByTestId('selected-count')).toHaveText('4');
    await page.keyboard.press('Delete');
    expect((await noteCounts(page))[0]).toBe(0);
    // Undo / Redo
    await page.keyboard.press('Meta+z');
    expect((await noteCounts(page))[0]).toBe(4);
    await page.keyboard.press('Meta+Shift+z');
    expect((await noteCounts(page))[0]).toBe(0);
    await page.getByTestId('btn-undo').click();
    expect((await noteCounts(page))[0]).toBe(4);
    await expect(page.getByTestId('dirty-indicator')).toContainText('未保存');
    // 最小間隔違反・同時刻衝突の表示
    await page.mouse.dblclick(box.x + xOf(9300), box.y + Y.l1);
    await expect(page.getByTestId('issues-list')).toContainText('最小間隔');
    // J: 再生ヘッド位置・編集中レベル（L2）へ追加
    await page.getByTestId('btn-activate-2').click();
    await page.mouse.click(box.x + xOf(12000), box.y + Y.ruler);
    await page.keyboard.press('j');
    expect((await noteCounts(page))[1]).toBe(1);
    await expect(page.getByTestId('input-hit-at')).toHaveValue('12000');
    // 他レベルの音符と衝突する位置へのダブルクリックは最寄りの空き位置へ追加される
    await page.mouse.dblclick(box.x + xOf(12000), box.y + Y.l3);
    expect((await noteCounts(page))[2]).toBe(1);
    const l3 = Number(await page.getByTestId('input-hit-at').inputValue());
    expect(Math.abs(l3 - 12000)).toBeGreaterThan(80);
    await expect(page.getByTestId('status-text')).toContainText('最寄りの空き位置');
  } finally {
    await closeEditor(app);
  }
});

test('サビ区間の追加・リサイズ・移動・削除', async () => {
  const { app, page } = await setup();
  try {
    const box = await canvasOrigin(page);
    // 追加（ストリップの空き位置をドラッグ）
    await page.mouse.move(box.x + xOf(4000), box.y + Y.chorus);
    await page.mouse.down();
    await page.mouse.move(box.x + xOf(8000), box.y + Y.chorus, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId('chorus-details')).toBeVisible();
    await expect(page.getByTestId('input-chorus-start')).toHaveValue('4000');
    await expect(page.getByTestId('input-chorus-end')).toHaveValue('8000');
    // 終了端のリサイズ 8000 → 10000
    await page.mouse.move(box.x + xOf(8000), box.y + Y.chorus);
    await page.mouse.down();
    await page.mouse.move(box.x + xOf(10000), box.y + Y.chorus, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId('input-chorus-end')).toHaveValue('10000');
    // 区間全体を移動 +1000ms
    await page.mouse.move(box.x + xOf(6000), box.y + Y.chorus);
    await page.mouse.down();
    await page.mouse.move(box.x + xOf(7000), box.y + Y.chorus, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByTestId('input-chorus-start')).toHaveValue('5000');
    await expect(page.getByTestId('input-chorus-end')).toHaveValue('11000');
    // 数値入力
    await page.getByTestId('input-chorus-start').fill('4500');
    await page.getByTestId('input-chorus-start').press('Enter');
    await expect(page.getByTestId('input-chorus-start')).toHaveValue('4500');
    // Undo で戻る
    await page.keyboard.press('Meta+z');
    await page.mouse.click(box.x + xOf(8000), box.y + Y.chorus);
    await expect(page.getByTestId('input-chorus-start')).toHaveValue('5000');
    // 削除
    await page.getByTestId('btn-delete-chorus').click();
    await expect(page.getByTestId('chorus-details')).toHaveCount(0);
    await page.keyboard.press('Meta+z');
    await page.mouse.click(box.x + xOf(8000), box.y + Y.chorus);
    await expect(page.getByTestId('chorus-details')).toBeVisible();
  } finally {
    await closeEditor(app);
  }
});

test('再生・シーク・速度変更・ループ・メトロノーム・試聴音', async () => {
  const { app, page } = await setup();
  try {
    const box = await canvasOrigin(page);
    await page.getByTestId('btn-play').click();
    await expect(page.getByTestId('btn-play')).toHaveAttribute('data-playing', 'true');
    await page.waitForTimeout(700);
    const t1 = await page.getByTestId('timecode').locator('.current').textContent();
    expect(t1).not.toBe('00:00.000');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('btn-play')).toHaveAttribute('data-playing', 'false');
    // シーク（ルーラークリック）
    await page.mouse.click(box.x + xOf(10000), box.y + Y.ruler);
    await expect(page.getByTestId('timecode').locator('.current')).toContainText('00:10.0');
    // 速度変更しても譜面時刻は原曲基準のまま（表示が倍率に依存しない）
    await page.getByTestId('select-rate').selectOption('0.5');
    await page.getByTestId('btn-play').click();
    await page.waitForTimeout(1000);
    await page.getByTestId('btn-play').click();
    const t2 = await page.getByTestId('timecode').locator('.current').textContent();
    const ms2 = parseTimecode(t2!);
    expect(ms2).toBeGreaterThan(10200);
    expect(ms2).toBeLessThan(11000); // 0.5x なので 1 秒で約 0.5 秒進む
    // ループ・メトロノーム・試聴音
    await page.getByTestId('btn-loop').click();
    await expect(page.getByTestId('btn-loop')).toHaveAttribute('data-on', 'true');
    await page.getByTestId('btn-metronome').click();
    await expect(page.getByTestId('btn-metronome')).toHaveAttribute('data-on', 'true');
    await page.getByTestId('btn-preview').click();
    await expect(page.getByTestId('btn-preview')).toHaveAttribute('data-on', 'true');
    await page.getByTestId('btn-stop').click();
    await expect(page.getByTestId('btn-play')).toHaveAttribute('data-playing', 'false');
  } finally {
    await closeEditor(app);
  }
});

function parseTimecode(s: string): number {
  const m = /(\d+):(\d+)\.(\d+)/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3]);
}
