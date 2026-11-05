import type { EditorApi } from '../../preload/index';

declare global {
  interface Window {
    autobeats: EditorApi;
  }
}

export const api: EditorApi = window.autobeats;
