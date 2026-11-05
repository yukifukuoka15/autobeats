import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, analyze, closeEditor, launchEditor, loadAudio, noteCounts, waitForWaveform } from './helpers';

const APP = process.env.AUTOBEATS_PACKAGED_EXE || (process.platform === 'win32'
  ? path.resolve(__dirname, '../../release/win-unpacked/AutoBeats Chart Editor.exe')
  : path.resolve(__dirname, `../../release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/AutoBeats Chart Editor.app/Contents/MacOS/AutoBeats Chart Editor`));

test('パッケージ済みアプリで MP3 読み込み・波形・解析ワーカーが動く', async () => {
  test.skip(!existsSync(APP), 'release/ にパッケージ済みアプリがありません（npm run package:mac -w apps/chart-editor）');
  const { app, page } = await launchEditor(undefined, APP);
  try {
    await loadAudio(app, page, path.join(FIXTURES, 'song.mp3'));
    await waitForWaveform(page);
    await analyze(page);
    expect((await noteCounts(page))[0]).toBeGreaterThan(0);
  } finally {
    await closeEditor(app);
  }
});


test('パッケージ済みアプリで同梱ランタイムからYouTubeを取り込める', async () => {
  const url = process.env.AUTOBEATS_YOUTUBE_TEST_URL;
  test.skip(!existsSync(APP) || !url, 'パッケージとAUTOBEATS_YOUTUBE_TEST_URLが必要です');
  const { app, page } = await launchEditor(undefined, APP);
  try {
    await page.getByTestId('youtube-url').fill(url!);
    await page.getByTestId('youtube-url').press('Enter');
    await expect(page.getByTestId('status-text')).toContainText('読み込みました', { timeout: 120000 });
    await expect(page.getByTestId('analysis-progress')).toHaveAttribute('data-status', 'idle', { timeout: 60000 });
    await expect(page.getByTestId('status-text')).not.toContainText('失敗');
    await waitForWaveform(page);
    await analyze(page);
    expect((await noteCounts(page))[0]).toBeGreaterThan(0);
  } finally {
    await closeEditor(app);
  }
});
