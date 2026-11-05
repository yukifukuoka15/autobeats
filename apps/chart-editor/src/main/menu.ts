import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '../shared/types';

export function buildAppMenu(send: (action: MenuAction) => void, recent: { id: string; name: string }[], openRecent: (id: string) => void): void {
  const isMac = process.platform === 'darwin';
  const recentItems: MenuItemConstructorOptions[] =
    recent.length > 0 ? recent.map((r) => ({ label: r.name, click: () => openRecent(r.id) })) : [{ label: '（なし）', enabled: false }];
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const, label: app.name }] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: '新規プロジェクト', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => send('new') },
        { label: 'プロジェクトを開く…', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: () => send('open') },
        { label: '最近使ったプロジェクト', submenu: recentItems },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => send('save') },
        { label: '名前を付けて保存…', accelerator: 'CmdOrCtrl+Shift+S', registerAccelerator: false, click: () => send('saveAs') },
        { type: 'separator' },
        { label: 'ゲーム用フォルダを書き出し…', accelerator: 'CmdOrCtrl+E', registerAccelerator: false, click: () => send('export') },
        { label: '譜面JSONだけ書き出し…', click: () => send('exportJson') },
        { label: '書き出したフォルダを検証…', click: () => send('verifyPackage') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    {
      label: '編集',
      submenu: [
        { label: '元に戻す', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => send('undo') },
        { label: 'やり直す', accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, click: () => send('redo') },
        { type: 'separator' },
        { label: '編集レーン内で全選択', accelerator: 'CmdOrCtrl+A', registerAccelerator: false, click: () => send('selectAll') },
        { type: 'separator' },
        { role: 'cut', label: 'カット' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: 'ペースト' },
      ],
    },
    {
      label: '解析',
      submenu: [{ label: 'AI自動解析（ローカル音響解析）', accelerator: 'CmdOrCtrl+R', registerAccelerator: false, click: () => send('analyze') }],
    },
    {
      label: '表示',
      submenu: [
        { label: 'タイムライン拡大', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: () => send('zoomIn') },
        { label: 'タイムライン縮小', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => send('zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
        { role: 'toggleDevTools', label: '開発者ツール' },
      ],
    },
    { role: 'windowMenu', label: 'ウィンドウ' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function sendToFocused(channel: string, ...args: unknown[]): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel, ...args);
}
