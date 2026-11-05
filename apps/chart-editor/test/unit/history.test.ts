import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, createHistory, isDirty, markSaved, present, redo, undo, MAX_HISTORY } from '../../src/renderer/src/store/history';

describe('history', () => {
  it('commit / undo / redo を往復し、保存位置へ戻ると未保存が解除される', () => {
    let h = createHistory('a');
    expect(isDirty(h)).toBe(false);
    h = commit(h, 'b', 'edit1');
    h = commit(h, 'c', 'edit2');
    expect(present(h)).toBe('c');
    expect(isDirty(h)).toBe(true);
    h = markSaved(h);
    expect(isDirty(h)).toBe(false);
    h = undo(h);
    expect(present(h)).toBe('b');
    expect(isDirty(h)).toBe(true);
    h = redo(h);
    expect(present(h)).toBe('c');
    expect(isDirty(h)).toBe(false);
    h = undo(undo(h));
    expect(present(h)).toBe('a');
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(true);
    // 分岐すると redo は消え、保存位置も無効になる
    h = commit(h, 'd', 'edit3');
    expect(canRedo(h)).toBe(false);
    expect(isDirty(h)).toBe(true);
    h = markSaved(h);
    h = undo(h);
    h = redo(h);
    expect(isDirty(h)).toBe(false);
  });

  it('履歴の上限を超えると古い項目を捨てる', () => {
    let h = createHistory(0);
    for (let i = 1; i <= MAX_HISTORY + 20; i++) h = commit(h, i, `e${i}`);
    expect(h.entries.length).toBe(MAX_HISTORY);
    expect(present(h)).toBe(MAX_HISTORY + 20);
    expect(isDirty(h)).toBe(true);
  });
});
