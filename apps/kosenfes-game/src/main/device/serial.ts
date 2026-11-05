import type { LedColor } from '../game/session';
import type { ButtonDevice, ButtonEvent, ButtonEventKind } from './types';

/**
 * 実物ボタン（シリアル接続）のプレースホルダー。
 * 実機プロトコルが確定したら connect() 内でポートを開き、受信した押下・解放を
 * listeners へ流し、setLed() でコマンドを送る。ネイティブ依存は追加していない。
 */
export class SerialButtonDevice implements ButtonDevice {
  readonly id = 'serial-button-1';
  readonly name = '実物ボタン（シリアル）';
  readonly kind = 'serial' as const;
  connected = false;
  private listeners: Record<ButtonEventKind, Set<(e: ButtonEvent) => void>> = { pressed: new Set(), released: new Set() };
  private ledListeners = new Set<(color: LedColor) => void>();

  async connect(): Promise<void> {
    throw new Error('実物ボタンは未接続です（シリアルプロトコル未実装）。仮想ボタンを選択してください。');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  on(kind: ButtonEventKind, listener: (e: ButtonEvent) => void): () => void {
    this.listeners[kind].add(listener);
    return () => this.listeners[kind].delete(listener);
  }

  onLed(listener: (color: LedColor) => void): () => void {
    this.ledListeners.add(listener);
    return () => this.ledListeners.delete(listener);
  }

  setLed(): void {
    // 未接続のため何もしない
  }
}
