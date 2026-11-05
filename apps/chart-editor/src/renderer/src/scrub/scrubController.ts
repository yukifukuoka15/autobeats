import { SCRUB, grainDurationFor, scrubStepFor, type ScrubModifiers } from './constants';
import type { ScrubDirection } from './grain';

/** トランスポートへの依存を抽象化（テストでは偽実装を注入） */
export interface ScrubTransport {
  /** 通常再生中か */
  isPlaying(): boolean;
  /** 音声が読み込まれているか */
  hasAudio(): boolean;
  durationMs(): number;
  /** 現在の再生ヘッド（整数 ms） */
  currentMs(): number;
  /** 再生ヘッドを移動する（通常再生は開始しない） */
  seek(ms: number): void;
  /** 音声片を鳴らす（ミュート時は内部で無視してよい） */
  playGrain(newTimeMs: number, direction: ScrubDirection, lengthMs: number): void;
  /** 音声片をすべて停止する */
  stopGrains(): void;
}

export interface ScrubTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export type ScrubKey = 'ArrowLeft' | 'ArrowRight';

export interface ScrubState {
  /** スクラブ中（短押し直後の待機を含む）か */
  active: boolean;
  /** 長押しによる連続移動中か */
  holding: boolean;
  direction: ScrubDirection;
  /** 最後に確定した再生ヘッド時刻 */
  timeMs: number;
}

export interface ScrubEvent {
  key: ScrubKey;
  shift: boolean;
  /** KeyboardEvent.altKey（UI 表記は Option） */
  option: boolean;
  /** OS のキーリピートイベントか（無視する） */
  repeat: boolean;
}

/**
 * 停止中の矢印キースクラブ。
 * - keydown で 1 ステップ移動し音声片を鳴らす
 * - holdDelayMs 以上押し続けたら repeatIntervalMs ごとに連続移動
 * - keyup / blur / visibilitychange / dispose で直ちに停止
 * - 左右同時押しは後から押した方向を優先し、離されたら残っている方へ戻る
 * 再生ヘッド時刻は整数 ms の論理値だけを更新し、描画座標には依存しない。
 */
export class ScrubController {
  private pressed: ScrubKey[] = [];
  private holdTimer: number | null = null;
  private repeatTimer: number | null = null;
  private mods: ScrubModifiers = { shift: false, option: false };
  private _state: ScrubState = { active: false, holding: false, direction: 1, timeMs: 0 };
  private listeners = new Set<(s: ScrubState) => void>();

  constructor(
    private readonly transport: ScrubTransport,
    private readonly timers: ScrubTimers = { setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (id) => window.clearTimeout(id), setInterval: (fn, ms) => window.setInterval(fn, ms), clearInterval: (id) => window.clearInterval(id) },
  ) {}

  get state(): ScrubState {
    return this._state;
  }

  subscribe(fn: (s: ScrubState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<ScrubState>): void {
    this._state = { ...this._state, ...patch };
    for (const l of this.listeners) l(this._state);
  }

  /** keydown。処理した（preventDefault すべき）場合 true */
  keyDown(e: ScrubEvent): boolean {
    if (e.repeat) return this.pressed.includes(e.key); // OS リピートは無視するが既に処理中なら既定動作は抑止
    if (this.transport.isPlaying() || !this.transport.hasAudio()) return false;
    this.mods = { shift: e.shift, option: e.option };
    const idx = this.pressed.indexOf(e.key);
    if (idx >= 0) this.pressed.splice(idx, 1);
    this.pressed.push(e.key);
    const direction: ScrubDirection = e.key === 'ArrowRight' ? 1 : -1;
    this.emit({ active: true, direction });
    this.step(direction);
    this.clearTimers();
    this.holdTimer = this.timers.setTimeout(() => this.startHold(), SCRUB.holdDelayMs);
    return true;
  }

  /** keyup。処理した場合 true */
  keyUp(key: ScrubKey): boolean {
    const idx = this.pressed.indexOf(key);
    if (idx < 0) return false;
    this.pressed.splice(idx, 1);
    if (this.pressed.length === 0) {
      this.stop();
      return true;
    }
    // まだ押されている方向へ切り替える（タイマーは継続）
    const remaining = this.pressed[this.pressed.length - 1]!;
    this.emit({ direction: remaining === 'ArrowRight' ? 1 : -1 });
    return true;
  }

  /** 修飾キーの変化（押しながら Shift を押した場合など） */
  setModifiers(mods: ScrubModifiers): void {
    this.mods = mods;
  }

  /** フォーカス喪失・非表示・アンマウント・プロジェクト切替で呼ぶ。直ちに停止 */
  cancel(): void {
    this.pressed = [];
    this.stop();
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  private stop(): void {
    this.clearTimers();
    this.transport.stopGrains();
    if (this._state.active || this._state.holding) this.emit({ active: false, holding: false, timeMs: this.transport.currentMs() });
  }

  private clearTimers(): void {
    if (this.holdTimer !== null) {
      this.timers.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.repeatTimer !== null) {
      this.timers.clearInterval(this.repeatTimer);
      this.repeatTimer = null;
    }
  }

  private startHold(): void {
    this.holdTimer = null;
    if (this.pressed.length === 0) return;
    this.emit({ holding: true });
    this.repeatTimer = this.timers.setInterval(() => this.repeatTick(), SCRUB.repeatIntervalMs);
  }

  private repeatTick(): void {
    if (this.pressed.length === 0 || this.transport.isPlaying()) {
      this.stop();
      return;
    }
    const moved = this.step(this._state.direction, true);
    // 境界に達したら繰り返しを止める（同じ音声片を鳴らし続けない）
    if (!moved) {
      this.clearTimers();
      this.emit({ holding: false });
    }
  }

  /** 1 ステップ移動して音声片を鳴らす。境界で動けなければ false */
  private step(direction: ScrubDirection, repeat = false): boolean {
    const base = repeat ? SCRUB.repeatStepMs : SCRUB.stepMs;
    const stepMs = Math.round((scrubStepFor(this.mods) / SCRUB.stepMs) * base);
    const duration = this.transport.durationMs();
    const current = this.transport.currentMs();
    const next = Math.min(duration, Math.max(0, current + direction * stepMs));
    if (next === current) {
      this.emit({ timeMs: current });
      return false;
    }
    this.transport.seek(next);
    this.transport.playGrain(next, direction, grainDurationFor(stepMs));
    this.emit({ timeMs: next, direction });
    return true;
  }
}
