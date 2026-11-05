import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import type { DeviceManager } from './device/manager';
import type { PlayController } from './game/controller';
import type { ImportService } from './services/importPackage';
import { type LibraryStore, toSummary } from './services/library';
import type { RankingsStore } from './services/rankings';
import type { SettingsStore } from './services/settings';
import { settingsSchema } from './services/settings';
import { GAMES } from './games/registry';

export interface IpcContext {
  settings: SettingsStore;
  library: LibraryStore;
  rankings: RankingsStore;
  importer: ImportService;
  devices: DeviceManager;
  controller: PlayController;
  getWindow: () => BrowserWindow | null;
}

const sessionIdSchema = z.string().uuid();
const trackRef = z.object({ trackId: z.string().min(1).max(64), audioSha256: z.string().regex(/^[0-9a-f]{64}$/) });

export function registerIpc(ctx: IpcContext): void {
  const handle = <T>(channel: string, schema: z.ZodType<T> | null, fn: (input: T) => Promise<unknown> | unknown) => {
    ipcMain.handle(channel, async (_event, raw: unknown) => {
      let input: T;
      if (schema) {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new Error(`不正な要求です (${channel})`);
        input = parsed.data;
      } else {
        input = undefined as T;
      }
      return fn(input);
    });
  };

  handle('app:info', null, () => ({ games: GAMES, version: '1.0.0' }));

  handle('library:list', null, async () => (await ctx.library.list()).map(toSummary));
  handle('library:import', z.object({ kind: z.enum(['folder', 'file']) }), async ({ kind }) => {
    const win = ctx.getWindow();
    const options: Electron.OpenDialogOptions = {
      title: kind === 'folder' ? 'ゲーム用フォルダを選択' : 'chart.json を選択',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
      filters: kind === 'file' ? [{ name: 'chart.json', extensions: ['json'] }] : [],
    };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (r.canceled || r.filePaths.length === 0) return { status: 'cancelled' };
    return ctx.importer.importFrom(r.filePaths[0]!);
  });
  handle('library:resolveConflict', z.object({ pendingId: z.string().uuid(), resolution: z.enum(['replace', 'new-id']) }), ({ pendingId, resolution }) =>
    ctx.importer.resolveConflict(pendingId, resolution, (t, s) => ctx.controller.isTrackInUse(t, s)),
  );
  handle('library:cancelConflict', z.object({ pendingId: z.string().uuid() }), ({ pendingId }) => {
    ctx.importer.cancelPending(pendingId);
    return null;
  });
  handle('library:delete', trackRef, async ({ trackId, audioSha256 }) => {
    if (ctx.controller.isTrackInUse(trackId, audioSha256)) return { ok: false, reason: 'プレイ中の楽曲は削除できません。' };
    const removed = await ctx.library.remove(trackId, audioSha256);
    if (!removed) return { ok: false, reason: '楽曲が見つかりません。' };
    const s = await ctx.settings.get();
    if (s.selectedTrackId === trackId && s.selectedAudioSha256 === audioSha256) {
      await ctx.settings.update({ selectedTrackId: null, selectedAudioSha256: null });
    }
    return { ok: true };
  });

  handle('settings:get', null, () => ctx.settings.get());
  handle('settings:update', settingsSchema.partial(), (patch) => ctx.settings.update(patch));

  handle('devices:list', null, () => ctx.devices.list());

  handle('rankings:get', z.object({ key: z.string().min(1).max(256) }), ({ key }) => ctx.rankings.get(key));
  handle('rankings:keys', null, () => ctx.rankings.keys());
  handle('rankings:rename', z.object({ key: z.string().min(1).max(256), id: z.string().uuid(), name: z.string().max(40) }), ({ key, id, name }) => ctx.rankings.rename(key, id, name));
  handle('rankings:delete', z.object({ key: z.string().min(1).max(256), id: z.string().uuid() }), ({ key, id }) => ctx.rankings.remove(key, id));
  handle('rankings:backup', null, async () => {
    const p = await ctx.rankings.backup();
    return { ok: p !== null };
  });

  handle('game:prepare', null, () => ctx.controller.prepare());
  handle('game:start', z.object({ sessionId: sessionIdSchema }), ({ sessionId }) => ctx.controller.start(sessionId));
  handle('game:audioStarted', z.object({ sessionId: sessionIdSchema, latencyMs: z.number().min(0).max(60000) }), ({ sessionId, latencyMs }) => {
    ctx.controller.audioStarted(sessionId, latencyMs);
    return null;
  });
  handle('game:audioPosition', z.object({ sessionId: sessionIdSchema, songTimeMs: z.number().finite() }), ({ sessionId, songTimeMs }) => {
    ctx.controller.audioPosition(sessionId, songTimeMs);
    return null;
  });
  handle('game:audioFailed', z.object({ sessionId: sessionIdSchema, message: z.string().max(500) }), ({ sessionId, message }) => {
    ctx.controller.audioFailed(sessionId, message);
    return null;
  });
  handle('game:abort', null, () => {
    ctx.controller.abort('user', 'プレイを中断しました。');
    return null;
  });
  handle('game:snapshot', null, () => ctx.controller.snapshot());
  handle('game:result', z.object({ sessionId: sessionIdSchema }), ({ sessionId }) => ctx.controller.getResult(sessionId));
  handle('game:registerName', z.object({ sessionId: sessionIdSchema, name: z.string().min(1).max(40) }), ({ sessionId, name }) => ctx.controller.registerName(sessionId, name));
  handle('game:virtualInput', z.object({ kind: z.enum(['pressed', 'released']) }), ({ kind }) => {
    ctx.controller.virtualInput(kind);
    return null;
  });
  handle('window:toggleFullscreen', null, () => {
    const win = ctx.getWindow();
    if (win) win.setFullScreen(!win.isFullScreen());
    return null;
  });
}
