import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, analyze, closeEditor, launchEditor, loadAudio, noteCounts, waitForWaveform } from './helpers';

test('新規作成 → MP3選択 → 波形表示 → AI自動解析 → 4レーンに音符', async () => {
  const { app, page } = await launchEditor();
  try {
    await expect(page.getByTestId('project-name')).toContainText('無題');
    await loadAudio(app, page, path.join(FIXTURES, 'song.mp3'));
    await expect(page.getByTestId('audio-info')).toContainText('MP3');
    await expect(page.getByTestId('audio-duration')).toContainText('01:09');
    await waitForWaveform(page);
    await analyze(page);
    const counts = await noteCounts(page);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[3]).toBeGreaterThan(counts[0]!);
    await expect(page.getByTestId('bpm-display')).toContainText('120');
    await expect(page.getByTestId('analysis-info')).toContainText('推定BPM');
  } finally {
    await closeEditor(app);
  }
});

test('壊れた MP3 と短すぎる音声を日本語で拒否する', async () => {
  const { app, page } = await launchEditor();
  try {
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    }, path.join(FIXTURES, 'broken.mp3'));
    await page.getByTestId('btn-open-audio').click();
    await expect(page.getByTestId('dialog-message')).toContainText('デコードできません', { timeout: 30000 });
    await page.getByTestId('dialog-ok').click();
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    }, path.join(FIXTURES, 'short.wav'));
    await page.getByTestId('btn-open-audio').click();
    await expect(page.getByTestId('dialog-message')).toContainText('短すぎます', { timeout: 30000 });
  } finally {
    await closeEditor(app);
  }
});
