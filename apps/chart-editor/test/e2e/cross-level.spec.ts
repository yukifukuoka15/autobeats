import { expect, test, type Page } from '@playwright/test';
import { CROSS_LEVEL_EXCLUSION_MS, findCrossLevelConflicts, serializeChart, type ChartFile } from '@autobeats/chart-format';
import { sha256File } from '@autobeats/chart-format/node';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FIXTURES, analyze, closeEditor, launchEditor, loadAudio, stubOpenDialog, stubSaveDialog, waitForWaveform } from './helpers';

const ZOOM = 60; // px/s（既定）
const Y = { ruler: 13, l1: 190, l2: 254, l3: 318, l4: 382 };
const xOf = (ms: number) => (ms / 1000) * ZOOM;

async function canvasBox(page: Page) {
  const box = await page.getByTestId('timeline-canvas').boundingBox();
  if (!box) throw new Error('canvas not found');
  return box;
}

/** キャンバスの指定位置（CSS px）の色を返す */
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

test('自動解析後は難易度間衝突が 0 件で、縦一列のマーカーが生成されない', async () => {
  const { app, page } = await launchEditor();
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    await analyze(page);
    await expect(page.getByTestId('issues-none')).toContainText('検証OK');
    await expect(page.getByTestId('issues-none')).toContainText(`難易度間の${CROSS_LEVEL_EXCLUSION_MS}ms以内の衝突`);
    // 書き出した JSON から全組み合わせを数える
    const dir = mkdtempSync(path.join(tmpdir(), 'autobeats-xl-'));
    const out = path.join(dir, 'chart.json');
    await stubSaveDialog(app, out);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:action', 'exportJson'));
    await expect(page.getByTestId('dialog-export-result')).toContainText('書き出しました');
    const chart = JSON.parse(readFileSync(out, 'utf8')) as ChartFile;
    const report = findCrossLevelConflicts(chart.levels, CROSS_LEVEL_EXCLUSION_MS);
    expect(report.total, JSON.stringify(report.countsByPair)).toBe(0);
    expect(chart.generationRules?.crossLevelExclusionMs).toBe(80);
    for (const k of ['1', '2', '3', '4'] as const) expect(chart.levels[k].notes.length).toBeGreaterThan(0);
    await page.getByTestId('dialog-ok').click();
    // 衝突位置へ手動追加しようとすると日本語エラー
    const l1 = chart.levels['1'].notes.find((n) => n.hitAtMs > 3000)!;
    const box = await canvasBox(page);
    await page.getByTestId('snap-enabled').uncheck();
    await page.mouse.dblclick(box.x + xOf(l1.hitAtMs), box.y + Y.l2);
    // 衝突位置には置かず、最寄りの空き位置へ追加するか（空きがなければ）追加しない。いずれも理由を表示する
    const status = (await page.getByTestId('status-text').textContent()) ?? '';
    expect(status).toMatch(/衝突のため最寄りの空き位置|追加できませんでした/);
    expect(status).toContain('LEVEL 1のヒット');
    expect(status).toContain(`難易度間の最小間隔は${CROSS_LEVEL_EXCLUSION_MS}msです`);
    if (/最寄りの空き位置/.test(status)) {
      const added = Number(await page.getByTestId('input-hit-at').inputValue());
      expect(Math.abs(added - l1.hitAtMs)).toBeGreaterThan(CROSS_LEVEL_EXCLUSION_MS);
    }
    await expect(page.getByTestId('issues-none')).toBeVisible();
  } finally {
    await closeEditor(app);
  }
});

test('ドラッグ中の衝突位置は警告色になり、離すと戻すか最寄り候補へ移動する', async () => {
  const { app, page } = await launchEditor();
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.wav'));
    await waitForWaveform(page);
    await page.getByTestId('snap-enabled').uncheck();
    const box = await canvasBox(page);
    await page.mouse.dblclick(box.x + xOf(2000), box.y + Y.l1);
    await page.mouse.dblclick(box.x + xOf(4000), box.y + Y.l2);
    await expect(page.getByTestId('input-hit-at')).toHaveValue('4000');
    // L2 の音符を L1 の音符（2000ms）の上へドラッグ
    await page.mouse.move(box.x + xOf(4000), box.y + Y.l2);
    await page.mouse.down();
    await page.mouse.move(box.x + xOf(3000), box.y + Y.l2, { steps: 5 });
    await page.mouse.move(box.x + xOf(2000), box.y + Y.l2, { steps: 5 });
    await page.waitForTimeout(100);
    const [r, g, b] = await pixelAt(page, xOf(2000), Y.l2);
    expect(r, `color ${r},${g},${b}`).toBeGreaterThan(180);
    expect(g).toBeLessThan(130);
    await page.mouse.up();
    const status = (await page.getByTestId('status-text').textContent()) ?? '';
    expect(status).toMatch(/衝突のため(元の位置へ戻しました|最寄りのスナップ候補)/);
    const value = Number(await page.getByTestId('input-hit-at').inputValue());
    expect(Math.abs(value - 2000)).toBeGreaterThan(CROSS_LEVEL_EXCLUSION_MS);
    await expect(page.getByTestId('issues-none')).toBeVisible();
    // 数値入力でも同じ共通判定
    await page.getByTestId('input-hit-at').fill('2030');
    await page.getByTestId('input-hit-at').press('Enter');
    await expect(page.getByTestId('status-text')).toContainText('LEVEL 1のヒット');
    expect(Number(await page.getByTestId('input-hit-at').inputValue())).toBe(value);
    // 拒否は Undo 履歴へ積まれない: 最寄り候補へ移動した場合は Undo 2 回（移動→追加）、戻した場合は 1 回で追加が戻る
    await page.keyboard.press('Meta+z');
    if (/最寄りのスナップ候補/.test(status)) {
      await expect(page.getByTestId('count-2')).toHaveText('L2: 1');
      await page.keyboard.press('Meta+z');
    }
    await expect(page.getByTestId('count-2')).toHaveText('L2: 0');
  } finally {
    await closeEditor(app);
  }
});

test('衝突を含む譜面の読み込みで警告と修復選択肢が出て、検証表示から該当箇所へ移動し、修復で正常状態になる', async () => {
  const { app, page } = await launchEditor();
  try {
    const audio = path.join(FIXTURES, 'song.wav');
    await loadAudio(app, page, audio);
    await waitForWaveform(page);
    // 衝突を含むパッケージを用意
    const dir = mkdtempSync(path.join(tmpdir(), 'autobeats-xl-pkg-'));
    const pkg = path.join(dir, 'bad-track');
    mkdirSync(pkg);
    copyFileSync(audio, path.join(pkg, 'audio.wav'));
    const durationMs = Number(((await page.getByTestId('audio-duration').textContent()) ?? '').replace(/(\d+):(\d+)\.(\d+)/, (_, m, s, ms) => String(Number(m) * 60000 + Number(s) * 1000 + Number(ms))));
    const chart: ChartFile = {
      format: 'kosen-rhythm-chart',
      formatVersion: 1,
      trackId: 'bad-track',
      title: 'bad',
      artist: '',
      audioFile: 'audio.wav',
      audioSha256: await sha256File(audio),
      durationMs,
      bpm: 120,
      offsetMs: 0,
      analysis: { engineVersion: 'test', analyzedAt: new Date().toISOString() },
      choruses: [],
      levels: {
        '1': { displayName: 'LEVEL 1', notes: [{ id: 'a', hitAtMs: 2000, source: 'generated' }, { id: 'a2', hitAtMs: 8000, source: 'generated' }] },
        '2': { displayName: 'LEVEL 2', notes: [{ id: 'b', hitAtMs: 2040, source: 'generated' }, { id: 'b2', hitAtMs: 12000, source: 'generated' }] },
        '3': { displayName: 'LEVEL 3', notes: [{ id: 'c', hitAtMs: 3000, source: 'generated' }] },
        '4': { displayName: 'LEVEL 4', notes: [{ id: 'd', hitAtMs: 3010, source: 'generated' }, { id: 'd2', hitAtMs: 20000, source: 'generated' }] },
      },
    };
    writeFileSync(path.join(pkg, 'chart.json'), serializeChart(chart));
    await stubOpenDialog(app, pkg);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:action', 'verifyPackage'));
    await expect(page.getByTestId('dialog-verify-result')).toBeVisible();
    await page.getByTestId('verify-import').click();
    // 読込時の警告と選択肢
    await expect(page.getByTestId('dialog-conflicts')).toContainText('難易度間の衝突があります');
    await expect(page.getByTestId('conflicts-by-pair')).toContainText('L1–L2: 1件');
    await expect(page.getByTestId('conflicts-by-pair')).toContainText('L3–L4: 1件');
    await expect(page.getByTestId('conflicts-regen')).toBeVisible();
    await expect(page.getByTestId('conflicts-repair')).toBeVisible();
    await expect(page.getByTestId('conflicts-readonly')).toBeVisible();
    await page.getByTestId('conflicts-cancel').click();
    // リアルタイム検証の件数表示
    await expect(page.getByTestId('issues-cross-level')).toContainText('難易度間の衝突: 2件');
    await expect(page.getByTestId('issues-pair-1-2')).toContainText('L1–L2: 1件');
    await expect(page.getByTestId('issues-pair-3-4')).toContainText('L3–L4: 1件');
    await expect(page.getByTestId('issues-pair-1-3')).toContainText('L1–L3: 0件');
    // 一覧から該当時刻へ移動
    await page.getByTestId('issue-jump').first().click();
    await expect(page.getByTestId('timecode').locator('.current')).toContainText('00:02.040');
    await expect(page.getByTestId('input-hit-at')).toHaveValue('2040');
    // 修復 → 正常状態
    await page.getByTestId('btn-repair-conflicts').click();
    await expect(page.getByTestId('dialog-message')).toContainText('難易度間の衝突を修復しました');
    await page.getByTestId('dialog-ok').click();
    await expect(page.getByTestId('issues-none')).toContainText('検証OK');
    await expect(page.getByTestId('count-1')).toHaveText('L1: 2');
    // 修復は 1 回の Undo で戻る
    await page.keyboard.press('Meta+z');
    await expect(page.getByTestId('issues-cross-level')).toContainText('難易度間の衝突: 2件');
    await page.keyboard.press('Meta+Shift+z');
    await expect(page.getByTestId('issues-none')).toBeVisible();
    // 書き出しは衝突があると禁止（全件表示）
    await page.keyboard.press('Meta+z');
    await page.getByTestId('btn-export').click();
    await expect(page.getByTestId('dialog-export-result')).toContainText('書き出しできません');
    await expect(page.getByTestId('dialog-lines')).toContainText('難易度間の衝突: 2件');
    await expect(page.getByTestId('dialog-lines')).toContainText('--- 全件 ---');
  } finally {
    await closeEditor(app);
  }
});
