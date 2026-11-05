import { SCRUB } from './constants';

export type ScrubDirection = 1 | -1;

export interface GrainPlan {
  /** 切り出し開始（楽曲時刻 ms、クランプ済み） */
  startMs: number;
  /** 切り出し長（ms） */
  lengthMs: number;
  /** 逆再生するか（左方向） */
  reverse: boolean;
}

/** 移動先周辺の音声片の範囲を決める。曲の範囲内に収める */
export function planGrain(newTimeMs: number, direction: ScrubDirection, lengthMs: number, durationMs: number): GrainPlan | null {
  if (durationMs <= 0) return null;
  const len = Math.min(lengthMs, durationMs);
  let start = Math.max(0, Math.min(durationMs - len, newTimeMs));
  if (direction < 0) start = Math.max(0, Math.min(durationMs - len, newTimeMs));
  if (!Number.isFinite(start)) return null;
  return { startMs: Math.round(start), lengthMs: Math.round(len), reverse: direction < 0 };
}

/**
 * チャンネル PCM から音声片を切り出し、必要なら逆順にし、頭と末尾へ線形フェードを掛ける。
 * 返り値は新しい Float32Array（元データは変更しない）。
 */
export function sliceGrain(channel: Float32Array, sampleRate: number, plan: GrainPlan, fadeMs: number = SCRUB.fadeMs): Float32Array {
  const start = Math.max(0, Math.min(channel.length, Math.round((plan.startMs / 1000) * sampleRate)));
  const len = Math.max(0, Math.min(channel.length - start, Math.round((plan.lengthMs / 1000) * sampleRate)));
  const out = new Float32Array(len);
  if (plan.reverse) for (let i = 0; i < len; i++) out[i] = channel[start + len - 1 - i]!;
  else out.set(channel.subarray(start, start + len));
  const fade = Math.min(Math.floor(len / 2), Math.round((fadeMs / 1000) * sampleRate));
  for (let i = 0; i < fade; i++) {
    const g = (i + 1) / (fade + 1);
    out[i] = out[i]! * g;
    out[len - 1 - i] = out[len - 1 - i]! * g;
  }
  return out;
}

/** 実際の音声出力を抽象化（テストでは偽実装を注入） */
export interface GrainAudio {
  /** 音声片を即時再生し、停止ハンドルを返す */
  play(channels: Float32Array[], sampleRate: number, gain: number): { stop(): void };
}

export interface GrainSource {
  sampleRate: number;
  durationMs: number;
  channels: Float32Array[];
}

/**
 * スクラブ音声片の再生管理。同時ノード数を制限し、古い音声片を停止する。
 * 音量が 0 以下（ミュート）または音声未読込なら何も鳴らさない。
 */
export class GrainPlayer {
  private active: { stop(): void }[] = [];

  constructor(
    private readonly audio: GrainAudio,
    private readonly maxActive: number = SCRUB.maxActiveGrains,
  ) {}

  get activeCount(): number {
    return this.active.length;
  }

  play(source: GrainSource | null, newTimeMs: number, direction: ScrubDirection, lengthMs: number, gain: number): GrainPlan | null {
    if (!source || gain <= 0) return null;
    const plan = planGrain(newTimeMs, direction, lengthMs, source.durationMs);
    if (!plan || plan.lengthMs <= 0) return null;
    const channels = source.channels.map((c) => sliceGrain(c, source.sampleRate, plan));
    if (channels.length === 0 || channels[0]!.length === 0) return null;
    while (this.active.length >= this.maxActive) this.active.shift()!.stop();
    const handle = this.audio.play(channels, source.sampleRate, gain);
    this.active.push({
      stop: () => {
        handle.stop();
      },
    });
    // 自然終了後の掃除（長さ分経過後）
    const h = this.active[this.active.length - 1]!;
    setTimeout(() => {
      const i = this.active.indexOf(h);
      if (i >= 0) this.active.splice(i, 1);
    }, plan.lengthMs + 20);
    return plan;
  }

  /** すべての音声片を直ちに停止する */
  stopAll(): void {
    for (const a of this.active) a.stop();
    this.active = [];
  }
}
