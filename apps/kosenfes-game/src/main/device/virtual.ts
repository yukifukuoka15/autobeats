import type { LedColor } from '../game/session';
import type { ButtonDevice, ButtonEvent, ButtonEventKind } from './types';

/**
 * 仮想ボタン（キーボード）。renderer から pressed/released の IPC を受けて
 * main の受信時刻でイベントを発行する。LED 状態は renderer へ通知する。
 */
export class VirtualButtonDevice implements ButtonDevice {
  readonly id = 'virtual-keyboard';
  readonly name = '仮想ボタン（キーボード: Space / J / F）';
  readonly kind = 'virtual' as const;
  connected = false;
  private listeners: Record<ButtonEventKind, Set<(e: ButtonEvent) => void>> = { pressed: new Set(), released: new Set() };
  private ledListeners = new Set<(color: LedColor) => void>();
  private seq = 0;
  private held = false;
  private ledTimer: ReturnType<typeof setTimeout> | null = null;
  private idleColor: LedColor = 'off';
  currentLed: LedColor = 'off';

  constructor(private readonly now: () => number = () => performance.now()) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.held = false;
    if (this.ledTimer) clearTimeout(this.ledTimer);
    this.setLed('off', 0);
  }

  on(kind: ButtonEventKind, listener: (e: ButtonEvent) => void): () => void {
    this.listeners[kind].add(listener);
    return () => this.listeners[kind].delete(listener);
  }

  onLed(listener: (color: LedColor) => void): () => void {
    this.ledListeners.add(listener);
    return () => this.ledListeners.delete(listener);
  }

  /** renderer からの入力。キーリピートは呼び出し側で除外する */
  inject(kind: ButtonEventKind): ButtonEvent | null {
    if (!this.connected) return null;
    if (kind === 'pressed') {
      if (this.held) return null;
      this.held = true;
    } else {
      if (!this.held) return null;
      this.held = false;
    }
    const e: ButtonEvent = { eventId: `v-${++this.seq}`, seq: this.seq, receivedAtMs: this.now() };
    for (const l of this.listeners[kind]) l(e);
    return e;
  }

  setLed(color: LedColor, durationMs: number): void {
    if (this.ledTimer) {
      clearTimeout(this.ledTimer);
      this.ledTimer = null;
    }
    if (durationMs <= 0) {
      this.idleColor = color;
      this.currentLed = color;
    } else {
      this.currentLed = color;
      this.ledTimer = setTimeout(() => {
        this.currentLed = this.idleColor;
        this.ledTimer = null;
        for (const l of this.ledListeners) l(this.currentLed);
      }, durationMs);
    }
    for (const l of this.ledListeners) l(this.currentLed);
  }
}
