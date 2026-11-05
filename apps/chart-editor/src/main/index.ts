import { app, BrowserWindow, dialog, shell } from 'electron';
import * as path from 'node:path';
import type { MenuAction } from '../shared/types';
import { loadProjectFromPath, registerIpc, session } from './ipc';
import { installMediaProtocol, registerMediaScheme } from './media';
import { buildAppMenu } from './menu';
import { displayPath } from './services/audioFile';
import { PROJECT_EXTENSION, readRecentList } from './services/project';

if (process.env['AUTOBEATS_USER_DATA']) {
  app.setPath('userData', process.env['AUTOBEATS_USER_DATA']);
}

registerMediaScheme();

let mainWindow: BrowserWindow | null = null;
let forceClose = false;

function sendMenu(action: MenuAction): void {
  mainWindow?.webContents.send('menu:action', action);
}

const menuRecentIds = new Map<string, string>();

async function rebuildMenu(): Promise<void> {
  const list = await readRecentList(app.getPath('userData'));
  menuRecentIds.clear();
  const entries = list.map((r, i) => {
    const id = `m${i}`;
    menuRecentIds.set(id, r.path);
    return { id, name: `${path.basename(r.path, PROJECT_EXTENSION)}  (${displayPath(r.path)})` };
  });
  buildAppMenu(sendMenu, entries, (id) => {
    const p = menuRecentIds.get(id);
    if (p) mainWindow?.webContents.send('menu:openRecentRequest', id);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'AutoBeats 譜面エディター',
    backgroundColor: '#101216',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:/.test(details.url)) void shell.openExternal(details.url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.on('close', (e) => {
    if (forceClose || !session.dirty) return;
    e.preventDefault();
    void (async () => {
      const r = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        message: '未保存の変更があります。閉じる前に保存しますか？',
        buttons: ['保存', '保存しない', 'キャンセル'],
        defaultId: 0,
        cancelId: 2,
      });
      if (r.response === 2) return;
      if (r.response === 1) {
        forceClose = true;
        mainWindow?.close();
        return;
      }
      // 保存: renderer に保存を依頼し、完了後に閉じる
      mainWindow?.webContents.send('app:saveThenClose');
    })();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  // 開発起動時も Dock にアプリアイコンを表示する（パッケージ時は resources/icon.icns を使う）
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../../resources/icon.png'));
  installMediaProtocol();
  registerIpc(rebuildMenu);
  const { ipcMain } = await import('electron');
  ipcMain.handle('app:closeAfterSave', () => {
    forceClose = true;
    mainWindow?.close();
  });
  ipcMain.handle('menu:openRecent', async (_e, id: unknown) => {
    const p = typeof id === 'string' ? menuRecentIds.get(id) : undefined;
    if (!p) return { ok: false, message: '最近使ったプロジェクトの項目が見つかりません。' };
    const result = await loadProjectFromPath(p);
    await rebuildMenu();
    return result;
  });
  await rebuildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
