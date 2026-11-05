import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, closeEditor, launchEditor, loadAudio, waitForWaveform } from './helpers';

const ZOOM = 60;
const Y = { ruler: 13, l1: 190 };
const xOf = (ms: number) => (ms / 1000) * ZOOM;

function parseTimecode(s: string): number {
  const m = /(\d+):(\d+)\.(\d+)/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3]);
}

async function current(page: Page): Promise<number> {
  return parseTimecode((await page.getByTestId('timecode').locator('.current').textContent()) ?? '');
}

test('停止中の矢印キースクラブ: 短押し・修飾キー・長押し・停止・未保存に影響しない', async () => {
  const { app, page } = await launchEditor();
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
    // 楽曲読み込み自体は履歴に入るので、その時点の未保存表示と Undo ラベルを基準にする
    const dirtyBefore = await page.getByTestId('dirty-indicator').textContent();
    const undoBefore = await page.getByTestId('btn-undo').getAttribute('title');
    await page.mouse.click(box.x + xOf(10000), box.y + Y.ruler); // 10000ms へシーク（キャンバスにフォーカス）
    expect(await current(page)).toBe(10000);
    await expect(page.getByTestId('scrub-hint')).toContainText('スクラブ');
    // 短押し
    await page.keyboard.press('ArrowRight');
    expect(await current(page)).toBe(10020);
    await page.keyboard.press('ArrowLeft');
    expect(await current(page)).toBe(10000);
    await page.keyboard.press('Shift+ArrowRight');
    expect(await current(page)).toBe(10100);
    await page.keyboard.press('Alt+ArrowLeft');
    expect(await current(page)).toBe(10099);
    await page.keyboard.press('Shift+Alt+ArrowRight');
    expect(await current(page)).toBe(10599);
    await expect(page.getByTestId('btn-play')).toHaveAttribute('data-playing', 'false');
    // 長押し（約 600ms）: 300ms 後から 60ms ごとに 20ms 進む
    await page.keyboard.down('ArrowRight');
    await expect(page.getByTestId('scrub-status')).toContainText('スクラブ中：', { timeout: 2000 });
    await page.waitForTimeout(400);
    await page.keyboard.up('ArrowRight');
    const afterHold = await current(page);
    expect(afterHold).toBeGreaterThan(10599 + 20 + 40); // 短押し分 + 連続移動
    expect(afterHold).toBeLessThan(10599 + 20 + 400); // ゆっくり（約 0.33 倍速）
    await expect(page.getByTestId('scrub-status')).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(await current(page)).toBe(afterHold); // 離した位置で止まる
    await expect(page.getByTestId('btn-play')).toHaveAttribute('data-playing', 'false');
    // 左方向の長押し
    await page.keyboard.down('ArrowLeft');
    await expect(page.getByTestId('scrub-status')).toContainText('逆方向スクラブ中：', { timeout: 2000 });
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowLeft');
    expect(await current(page)).toBeLessThan(afterHold - 20);
    // スクラブは編集データを変えない: 未保存表示と Undo 対象が変わらない
    expect(await page.getByTestId('dirty-indicator').textContent()).toBe(dirtyBefore);
    expect(await page.getByTestId('btn-undo').getAttribute('title')).toBe(undoBefore);
    // スクラブ後に再生するとその位置から始まる
    const start = await current(page);
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    await page.keyboard.press('Space');
    const played = await current(page);
    expect(played).toBeGreaterThan(start + 300);
    expect(played).toBeLessThan(start + 1500);
  } finally {
    await closeEditor(app);
  }
});

test('入力欄フォーカス中はスクラブせず、端に近づいたときだけ波形が追従する', async () => {
  const { app, page } = await launchEditor();
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
    await page.mouse.click(box.x + xOf(5000), box.y + Y.ruler);
    // 入力欄では矢印キーがカーソル移動に使われる
    await page.getByTestId('input-title').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await current(page)).toBe(5000);
    await expect(page.getByTestId('scrub-hint')).toHaveCount(0);
    // タイムラインへ戻してスクラブ。表示範囲の中央付近ではスクロールしない
    await page.mouse.click(box.x + xOf(5000), box.y + Y.ruler);
    const scrollBefore = await page.getByTestId('scrollbar').inputValue();
    await page.keyboard.press('ArrowRight');
    expect(await page.getByTestId('scrollbar').inputValue()).toBe(scrollBefore);
    // 右端 10% へ再生ヘッドを置いてスクラブすると追従する
    const widthMs = (box.width / ZOOM) * 1000;
    const edgeMs = Math.round(widthMs * 0.95);
    await page.mouse.click(box.x + xOf(edgeMs), box.y + Y.ruler);
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowRight');
    expect(Number(await page.getByTestId('scrollbar').inputValue())).toBeGreaterThan(Number(scrollBefore));
    // 再生ヘッドは表示範囲内に留まる
    const scroll = Number(await page.getByTestId('scrollbar').inputValue());
    const now = await current(page);
    expect(now).toBeGreaterThan(scroll);
    expect(now).toBeLessThan(scroll + widthMs);
    // 音符選択中でも矢印はスクラブ、Command+矢印が音符移動
    await page.getByTestId('snap-enabled').uncheck();
    await page.mouse.dblclick(box.x + xOf(scroll + 2000 - scroll) + 0, box.y + Y.l1);
    const noteMs = Number(await page.getByTestId('input-hit-at').inputValue());
    const before = await current(page);
    await page.keyboard.press('ArrowRight');
    expect(Number(await page.getByTestId('input-hit-at').inputValue())).toBe(noteMs);
    expect(await current(page)).toBe(before + 20);
    await page.keyboard.press('Meta+ArrowRight');
    expect(Number(await page.getByTestId('input-hit-at').inputValue())).toBe(noteMs + 1);
  } finally {
    await closeEditor(app);
  }
});
