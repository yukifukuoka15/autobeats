import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AudioOpenResult,
  EditorDocument,
  ExportStatus,
  LibraryEntrySummary,
  MenuAction,
  ProjectLoadResult,
  ProjectSaveResult,
  RecentEntry,
  RecoveryEntry,
  UnsavedChoice,
  VerifyPackageResult,
  ViewState,
} from '../shared/types';

type Listener<T> = (payload: T) => void;
function subscribe<T>(channel: string, cb: Listener<T>): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  importYoutube: (text: string): Promise<AudioOpenResult> => ipcRenderer.invoke('audio:youtube', text),
  openAudioDialog: (): Promise<AudioOpenResult> => ipcRenderer.invoke('audio:openDialog'),
  relocateAudioDialog: (): Promise<AudioOpenResult> => ipcRenderer.invoke('audio:relocateDialog'),
  mediaUrl: (token: string): string => `autobeats-media://audio/${token}`,
  projectNew: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('project:new'),
  projectOpenDialog: (): Promise<ProjectLoadResult> => ipcRenderer.invoke('project:openDialog'),
  projectSave: (doc: EditorDocument, view: ViewState, opts: { saveAs?: boolean }): Promise<ProjectSaveResult> => ipcRenderer.invoke('project:save', doc, view, opts),
  projectState: (): Promise<{ projectName: string | null }> => ipcRenderer.invoke('project:state'),
  setDirty: (dirty: boolean): Promise<void> => ipcRenderer.invoke('project:setDirty', dirty),
  confirmUnsaved: (message: string): Promise<UnsavedChoice> => ipcRenderer.invoke('project:confirmUnsaved', message),
  recentList: (): Promise<RecentEntry[]> => ipcRenderer.invoke('recent:list'),
  recentOpen: (id: string): Promise<ProjectLoadResult> => ipcRenderer.invoke('recent:open', id),
  autosaveWrite: (doc: EditorDocument, view: ViewState): Promise<{ ok: boolean }> => ipcRenderer.invoke('autosave:write', doc, view),
  autosaveClearCurrent: (): Promise<void> => ipcRenderer.invoke('autosave:clearCurrent'),
  recoveryList: (): Promise<RecoveryEntry[]> => ipcRenderer.invoke('recovery:list'),
  recoveryOpen: (id: string): Promise<ProjectLoadResult> => ipcRenderer.invoke('recovery:open', id),
  recoveryDiscard: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('recovery:discard', id),
  exportPackage: (doc: EditorDocument, opts: { requestId?: string; mode?: 'ask' | 'overwrite' | 'rename' }): Promise<ExportStatus> => ipcRenderer.invoke('export:package', doc, opts),
  exportChartJson: (doc: EditorDocument): Promise<{ status: 'ok'; displayPath: string; warnings: { code: string; message: string }[] } | { status: 'cancelled' } | { status: 'error'; errors: { code: string; message: string }[] }> =>
    ipcRenderer.invoke('export:chartJson', doc),
  verifyPackageDialog: (doc: EditorDocument | null): Promise<VerifyPackageResult | null> => ipcRenderer.invoke('package:verifyDialog', doc),
  showError: (title: string, message: string): Promise<void> => ipcRenderer.invoke('app:showError', title, message),
  libraryList: (): Promise<LibraryEntrySummary[]> => ipcRenderer.invoke('library:list'),
  libraryOpen: (id: string): Promise<ProjectLoadResult> => ipcRenderer.invoke('library:open', id),
  libraryRemove: (id: string): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('library:remove', id),
  closeAfterSave: (): Promise<void> => ipcRenderer.invoke('app:closeAfterSave'),
  onMenu: (cb: Listener<MenuAction>): (() => void) => subscribe('menu:action', cb),
  menuOpenRecent: (id: string): Promise<ProjectLoadResult> => ipcRenderer.invoke('menu:openRecent', id),
  onMenuOpenRecent: (cb: Listener<string>): (() => void) => subscribe('menu:openRecentRequest', cb),
  onSaveThenClose: (cb: () => void): (() => void) => subscribe('app:saveThenClose', cb),
};

contextBridge.exposeInMainWorld('autobeats', api);
export type EditorApi = typeof api;
