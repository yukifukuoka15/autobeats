import type { LedColor } from '../game/session';

export interface ButtonEvent {
  eventId: string;
  seq: number;
  /** Mac 受信時刻（main の performance.now() 基準） */
  receivedAtMs: number;
}

export type ButtonEventKind = 'pressed' | 'released';

export interface ButtonDevice {
  readonly id: string;
  readonly name: string;
  readonly kind: 'virtual' | 'serial';
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(kind: ButtonEventKind, listener: (e: ButtonEvent) => void): () => void;
  /** LED 色を設定する。durationMs > 0 なら経過後に待機色へ戻す。応答を待たない */
  setLed(color: LedColor, durationMs: number): void;
  onLed(listener: (color: LedColor) => void): () => void;
}
