/** スナップショット方式の Undo/Redo 履歴。savedIndex により保存状態へ戻ったときに未保存表示を解除できる */
export interface History<T> {
  entries: T[];
  index: number;
  savedIndex: number;
  labels: string[];
}

export const MAX_HISTORY = 200;

export function createHistory<T>(initial: T): History<T> {
  return { entries: [initial], index: 0, savedIndex: 0, labels: ['初期状態'] };
}

export function present<T>(h: History<T>): T {
  return h.entries[h.index]!;
}

export function commit<T>(h: History<T>, next: T, label: string): History<T> {
  let entries = h.entries.slice(0, h.index + 1);
  let labels = h.labels.slice(0, h.index + 1);
  let savedIndex = h.savedIndex > h.index ? -1 : h.savedIndex;
  entries.push(next);
  labels.push(label);
  let index = entries.length - 1;
  if (entries.length > MAX_HISTORY) {
    const drop = entries.length - MAX_HISTORY;
    entries = entries.slice(drop);
    labels = labels.slice(drop);
    index -= drop;
    savedIndex = savedIndex - drop < 0 ? -1 : savedIndex - drop;
  }
  return { entries, index, savedIndex, labels };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.index > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.index < h.entries.length - 1;
}

export function undo<T>(h: History<T>): History<T> {
  return canUndo(h) ? { ...h, index: h.index - 1 } : h;
}

export function redo<T>(h: History<T>): History<T> {
  return canRedo(h) ? { ...h, index: h.index + 1 } : h;
}

export function markSaved<T>(h: History<T>): History<T> {
  return { ...h, savedIndex: h.index };
}

export function isDirty<T>(h: History<T>): boolean {
  return h.index !== h.savedIndex;
}

export function undoLabel<T>(h: History<T>): string | null {
  return canUndo(h) ? h.labels[h.index]! : null;
}

export function redoLabel<T>(h: History<T>): string | null {
  return canRedo(h) ? h.labels[h.index + 1]! : null;
}
