import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DeviceInfo,
  FinishedResult,
  GameSettings,
  ImportResult,
  LibraryEntrySummary,
  PrepareResult,
  RankingRow,
  SessionEvent,
  SessionSnapshot,
  AbortReason,
} from '../shared/types';

type Listener<T> = (payload: T) => void;

function subscribe<T>(channel: string, listener: Listener<T>): () => void {
  const wrapped = (_e: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  app: {
    info: (): Promise<{ games: { id: string; displayName: string; modes: string[] }[]; version: string }> => ipcRenderer.invoke('app:info'),
    toggleFullscreen: (): Promise<null> => ipcRenderer.invoke('window:toggleFullscreen'),
  },
  library: {
    list: (): Promise<LibraryEntrySummary[]> => ipcRenderer.invoke('library:list'),
    import: (kind: 'folder' | 'file'): Promise<ImportResult> => ipcRenderer.invoke('library:import', { kind }),
    resolveConflict: (pendingId: string, resolution: 'replace' | 'new-id'): Promise<ImportResult> => ipcRenderer.invoke('library:resolveConflict', { pendingId, resolution }),
    cancelConflict: (pendingId: string): Promise<null> => ipcRenderer.invoke('library:cancelConflict', { pendingId }),
    delete: (trackId: string, audioSha256: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('library:delete', { trackId, audioSha256 }),
  },
  settings: {
    get: (): Promise<GameSettings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<GameSettings>): Promise<GameSettings> => ipcRenderer.invoke('settings:update', patch),
  },
  devices: {
    list: (): Promise<DeviceInfo[]> => ipcRenderer.invoke('devices:list'),
  },
  rankings: {
    get: (key: string): Promise<RankingRow[]> => ipcRenderer.invoke('rankings:get', { key }),
    keys: (): Promise<string[]> => ipcRenderer.invoke('rankings:keys'),
    rename: (key: string, id: string, name: string): Promise<boolean> => ipcRenderer.invoke('rankings:rename', { key, id, name }),
    delete: (key: string, id: string): Promise<boolean> => ipcRenderer.invoke('rankings:delete', { key, id }),
    backup: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('rankings:backup'),
  },
  game: {
    prepare: (): Promise<PrepareResult> => ipcRenderer.invoke('game:prepare'),
    start: (sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }> => ipcRenderer.invoke('game:start', { sessionId }),
    audioStarted: (sessionId: string, latencyMs: number): Promise<null> => ipcRenderer.invoke('game:audioStarted', { sessionId, latencyMs }),
    audioPosition: (sessionId: string, songTimeMs: number): Promise<null> => ipcRenderer.invoke('game:audioPosition', { sessionId, songTimeMs }),
    audioFailed: (sessionId: string, message: string): Promise<null> => ipcRenderer.invoke('game:audioFailed', { sessionId, message }),
    abort: (): Promise<null> => ipcRenderer.invoke('game:abort'),
    snapshot: (): Promise<SessionSnapshot | null> => ipcRenderer.invoke('game:snapshot'),
    result: (sessionId: string): Promise<FinishedResult | null> => ipcRenderer.invoke('game:result', { sessionId }),
    registerName: (sessionId: string, name: string): Promise<{ ok: true; rank: number | null } | { ok: false; reason: string }> => ipcRenderer.invoke('game:registerName', { sessionId, name }),
    virtualInput: (kind: 'pressed' | 'released'): Promise<null> => ipcRenderer.invoke('game:virtualInput', { kind }),
    onSnapshot: (listener: Listener<SessionSnapshot>) => subscribe('game:snapshot', listener),
    onEvent: (listener: Listener<SessionEvent>) => subscribe('game:event', listener),
    onFinished: (listener: Listener<{ result: FinishedResult; abortReason: AbortReason | null; abortMessage: string | null }>) => subscribe('game:finished', listener),
  },
  device: {
    onLed: (listener: Listener<{ color: string }>) => subscribe('device:led', listener),
  },
};

contextBridge.exposeInMainWorld('kosenfes', api);
export type GameApi = typeof api;
