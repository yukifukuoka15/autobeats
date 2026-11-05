import { useSyncExternalStore } from 'react';

/** 再生ヘッド位置だけを高頻度に配信する軽量ストア（他の UI の再描画を避ける） */
let currentMs = 0;
let playing = false;
const listeners = new Set<() => void>();

export function setPlayhead(ms: number, isPlaying: boolean): void {
  if (ms === currentMs && playing === isPlaying) return;
  currentMs = ms;
  playing = isPlaying;
  for (const l of listeners) l();
}

export function getPlayhead(): { ms: number; playing: boolean } {
  return snapshot;
}

let snapshot = { ms: 0, playing: false };
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => {
  if (snapshot.ms !== currentMs || snapshot.playing !== playing) snapshot = { ms: currentMs, playing };
  return snapshot;
};

export function usePlayhead(): { ms: number; playing: boolean } {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
