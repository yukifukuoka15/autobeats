import type { GameApi } from '../../preload/index';

declare global {
  interface Window {
    kosenfes: GameApi;
  }
}

export const api: GameApi = window.kosenfes;
