import { app, BrowserWindow, Menu, net, protocol, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeviceManager } from './device/manager';
import { PlayController } from './game/controller';
import { registerIpc } from './ipc';
import { MediaTokenRegistry } from './mediaTokens';
import { ImportService } from './services/importPackage';
import { LibraryStore } from './services/library';
import { RankingsStore } from './services/rankings';
import { SettingsStore } from './services/settings';

const MEDIA_SCHEME = 'kosenfes-media';

if (process.env['KOSENFES_USER_DATA']) {
  app.setPath('userData', process.env['KOSENFES_USER_DATA']);
}

// renderer は file:// から fetch するため CORS を許可する（応答側で Access-Control-Allow-Origin を付ける）
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: false } }]);

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d12',
    title: '高専祭ゲーム',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler((details) => {
    if (/^https?:/.test(details.url)) void shell.openExternal(details.url);
    return { action: 'deny' };
  });
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { label: '表示', submenu: [{ role: 'togglefullscreen', label: 'フルスクリーン切替' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const settings = new SettingsStore(userData);
  const library = new LibraryStore(userData);
  const rankings = new RankingsStore(userData);
  const importer = new ImportService(library);
  const devices = new DeviceManager();
  const tokens = new MediaTokenRegistry();
  await settings.load();

  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    // 形式: kosenfes-media://audio/<token>
    const token = url.hostname === 'audio' ? url.pathname.replace(/^\//, '') : '';
    const filePath = tokens.resolve(token);
    if (!filePath) return new Response('not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  });

  const controller = new PlayController({
    settings,
    library,
    rankings,
    devices,
    emit: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    },
    registerAudioToken: (p) => tokens.register(p),
    revokeAudioToken: (t) => tokens.revoke(t),
  });

  registerIpc({ settings, library, rankings, importer, devices, controller, getWindow: () => mainWindow });
  buildMenu();
  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    controller.dispose();
    mainWindow = null;
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
