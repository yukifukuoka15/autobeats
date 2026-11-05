import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writeTestPackage } from '../helpers/package';

/**
 * パッケージ済みアプリ（npm run package:mac 後）が存在する場合だけ実行する。
 * 静的資産・preload・カスタムプロトコルがパッケージ後のパスで解決できることを確認する。
 */
const APP_BINARY = process.env.KOSENFES_PACKAGED_EXE || (process.platform === 'win32'
  ? path.resolve(__dirname, '../../release/win-unpacked/Kosenfes Game.exe')
  : path.resolve(__dirname, `../../release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Kosenfes Game.app/Contents/MacOS/Kosenfes Game`));

test.skip(!existsSync(APP_BINARY), 'パッケージ済みアプリがありません（npm run package:mac -w apps/kosenfes-game）');

test('パッケージ済みアプリで取り込みと楽曲モードの準備ができる', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'kosenfes-packaged-'));
  const pkgDir = path.join(userData, 'pkg');
  await writeTestPackage(pkgDir, { trackId: 'packaged-track', title: 'パッケージ確認', durationSec: 6 });
  const app = await electron.launch({ executablePath: APP_BINARY, env: { ...process.env, KOSENFES_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="tab-admin"]');
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
    }, pkgDir);
    await page.getByTestId('import-folder').click();
    await expect(page.getByTestId('admin-message')).toContainText('取り込みました');
    await page.getByTestId('select-packaged-track').click();
    await page.getByTestId('tab-game').click();
    // 音声がカスタムプロトコル経由でデコードできれば「開始」が有効になる
    await expect(page.getByTestId('start-button')).toBeEnabled({ timeout: 15000 });
    await expect(page.getByTestId('game-title')).toContainText('パッケージ確認');
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
