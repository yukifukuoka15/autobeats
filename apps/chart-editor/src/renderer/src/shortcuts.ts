import { controller } from './controller';
import { editorStore } from './store/editorStore';

/** 入力欄・ダイアログ内など、矢印キーをアプリで奪ってはいけないフォーカス先か（共通判定） */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  return el.closest('[role="dialog"]') !== null;
}

export function handleKeyUp(e: KeyboardEvent): void {
  if (editorStore.getState().playtest.open) return;
  if ((e.key === 'f' || e.key === 'F') && controller.mashActive) {
    e.preventDefault();
    controller.endMash();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (controller.scrub.keyUp(e.key)) e.preventDefault();
  }
  if (e.key === 'Shift' || e.key === 'Alt') controller.scrub.setModifiers({ shift: e.shiftKey, option: e.altKey });
}

/**
 * macOS 慣習のショートカット。
 * メニュー項目のアクセラレータは表示専用（registerAccelerator: false）にし、ここで一元的に処理する。
 */
export function handleKeyDown(e: KeyboardEvent): void {
  // プレイテスト中は画面側が Q/W/O/P と Esc を処理する
  if (editorStore.getState().playtest.open) return;
  const editing = isEditable(e.target);
  if (editorStore.getState().dialog.kind !== 'none') {
    if (e.key === 'Escape') editorStore.setDialog({ kind: 'none' });
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    const k = e.key.toLowerCase();
    const run = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    // Command + ←→: 選択ヒット／サビ区間の移動（1ms、Shift で 10ms）。矢印単体は再生ヘッドのスクラブに使う
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !editing) {
      const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
      const sel = editorStore.getState().selection;
      if (sel?.kind === 'notes') return run(() => editorStore.moveSelectedNotes(delta)); // 拒否時は履歴へ積まず理由を表示する
      if (sel?.kind === 'chorus') return run(() => editorStore.moveChorus(sel.id, delta));
      return;
    }
    if (k === 'z' && !editing) return run(() => (e.shiftKey ? editorStore.redo() : editorStore.undo()));
    if (k === 'a' && !editing) return run(() => editorStore.selectAllInActiveLevel());
    if (k === 's') return run(() => void controller.save(e.shiftKey));
    if (k === 'n') return run(() => void controller.newProject());
    if (k === 'o') return run(() => void controller.openProject());
    if (k === 'e') return run(() => void controller.exportPackage());
    if (k === 'r') return run(() => void controller.analyze());
    if (k === 'p' && !e.shiftKey) return run(() => controller.openPlaytest());
    if (k === '=' || k === '+') return run(() => controller.zoom(1.25));
    if (k === '-' || k === '_') return run(() => controller.zoom(1 / 1.25));
    return;
  }
  if (e.code === 'Space' && !editing) {
    e.preventDefault();
    void controller.togglePlay();
    return;
  }
  if (e.key === 'Shift' || e.key === 'Alt') controller.scrub.setModifiers({ shift: e.shiftKey, option: e.altKey });
  if (editing) return;
  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      editorStore.deleteSelection();
      return;
    case 'f':
    case 'F':
      // F を押している間が連打（離した時点で確定）。OS のキーリピートは無視
      if (e.metaKey) return;
      e.preventDefault();
      if (!e.repeat) controller.beginMash();
      return;
    case 'Enter':
    case 'n':
    case 'N':
    case 'j':
    case 'J':
      // 再生ヘッド位置・編集中レベルへヒットを追加（再生中のタップ入力にも使える）
      if (e.metaKey || e.repeat) return;
      e.preventDefault();
      controller.addNoteAtPlayhead();
      return;
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault();
      // 停止中: キーボードスクラブ（短押し 20ms、長押しで連続）。再生中: 従来どおり再生ヘッドを 10/100ms 移動
      if (controller.scrub.keyDown({ key: e.key, shift: e.shiftKey, option: e.altKey, repeat: e.repeat })) return;
      if (controller.isPlaying() && !e.repeat) controller.nudgePlayhead((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 100 : 10));
      return;
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault();
      const levels = ['1', '2', '3'] as const;
      const cur = levels.findIndex((k) => k === editorStore.getState().view.activeLevel);
      const next = levels[Math.max(0, Math.min(2, cur + (e.key === 'ArrowDown' ? 1 : -1)))]!;
      editorStore.setView({ activeLevel: next });
      return;
    }
    case '+':
    case '=':
      if (!e.metaKey) {
        e.preventDefault();
        controller.zoom(1.25);
      }
      return;
    case '-':
    case '_':
      if (!e.metaKey) {
        e.preventDefault();
        controller.zoom(1 / 1.25);
      }
      return;
    case 'Home':
      controller.seekToStart();
      return;
    case 'End':
      controller.seekToEnd();
      return;
    case 'Escape':
      editorStore.setSelection(null);
      return;
    case 'm':
      controller.toggleMetronome();
      return;
    case 'l':
      controller.toggleLoop();
      return;
  }
}
