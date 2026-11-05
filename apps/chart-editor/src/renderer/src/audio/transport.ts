/**
 * Web Audio ベースの再生トランスポート。
 * ctx.currentTime を唯一の時計とし、楽曲時刻 = anchorSongMs + (ctx.currentTime - anchorCtxTime) * rate * 1000。
 * メトロノームと試聴音は look-ahead でスケジュールし、原曲とは別の GainNode で音量を独立させる。
 */
import { GrainPlayer, type GrainAudio, type ScrubDirection } from '../scrub/grain';

export interface TransportOptions {
  getBeats: () => readonly number[];
  getDownbeats: () => readonly number[];
  getPreviewNotes: () => readonly number[];
}

export class Transport {
  readonly ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private songGain: GainNode;
  private metroGain: GainNode;
  private previewGain: GainNode;
  private anchorSongMs = 0;
  private anchorCtxTime = 0;
  private _playing = false;
  private _rate = 1;
  private loop: { enabled: boolean; startMs: number; endMs: number } = { enabled: false, startMs: 0, endMs: 0 };
  private metronomeOn = false;
  private previewOn = false;
  private scheduledUntilMs = -Infinity;
  private schedulerTimer: number | null = null;
  private options: TransportOptions;
  private onEnded: (() => void) | null = null;
  private grains: GrainPlayer;

  constructor(options: TransportOptions) {
    this.options = options;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.songGain = this.ctx.createGain();
    this.metroGain = this.ctx.createGain();
    this.previewGain = this.ctx.createGain();
    this.songGain.connect(this.ctx.destination);
    this.metroGain.connect(this.ctx.destination);
    this.previewGain.connect(this.ctx.destination);
    const audio: GrainAudio = {
      play: (channels, sampleRate, gain) => {
        // 小さな AudioBuffer を作って原曲ゲイン経由で即時再生する（原曲音量を反映、メトロノーム/試聴音量は使わない）
        const buf = this.ctx.createBuffer(channels.length, channels[0]!.length, sampleRate);
        channels.forEach((c, i) => buf.getChannelData(i).set(c));
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const env = this.ctx.createGain();
        env.gain.value = gain;
        src.connect(env);
        env.connect(this.songGain);
        src.start();
        return {
          stop: () => {
            try {
              src.stop();
            } catch {
              // 既に停止
            }
            src.disconnect();
            env.disconnect();
          },
        };
      },
    };
    this.grains = new GrainPlayer(audio);
  }

  /** スクラブ音声片: 移動先周辺の音声を短く鳴らす（左方向は逆再生）。原曲がミュート（音量 0）なら鳴らさない */
  playScrubGrain(newTimeMs: number, direction: ScrubDirection, lengthMs: number): void {
    if (!this.buffer) return;
    const gain = this.songGain.gain.value;
    if (gain <= 0) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const channels: Float32Array[] = [];
    for (let i = 0; i < this.buffer.numberOfChannels; i++) channels.push(this.buffer.getChannelData(i));
    this.grains.play({ sampleRate: this.buffer.sampleRate, durationMs: this.durationMs, channels }, newTimeMs, direction, lengthMs, 1);
  }

  stopScrubGrains(): void {
    this.grains.stopAll();
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.stop();
    this.grains.stopAll();
    this.buffer = buffer;
    this.anchorSongMs = 0;
  }

  get hasBuffer(): boolean {
    return this.buffer !== null;
  }

  get durationMs(): number {
    return this.buffer ? Math.round(this.buffer.duration * 1000) : 0;
  }

  get playing(): boolean {
    return this._playing;
  }

  get rate(): number {
    return this._rate;
  }

  setOnEnded(cb: (() => void) | null): void {
    this.onEnded = cb;
  }

  /** 現在の楽曲時刻（ms、小数）。予約開始前は開始位置のまま */
  currentMs(): number {
    if (!this._playing) return this.anchorSongMs;
    if (this.ctx.currentTime < this.anchorCtxTime) return this.anchorSongMs;
    const t = this.anchorSongMs + (this.ctx.currentTime - this.anchorCtxTime) * this._rate * 1000;
    return Math.min(this.durationMs, Math.max(0, t));
  }

  /**
   * 現在位置から delaySec 後に再生を開始する（カウントダウン用）。開始時刻（ctx 時間）を返す。
   * 音声の開始と楽曲時刻 0 の対応はこの時刻で固定され、以後ずれを累積しない。
   */
  playScheduled(delaySec: number): number {
    if (!this.buffer) return this.ctx.currentTime;
    if (this._playing) this.stopSource();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const pos = Math.min(this.durationMs, Math.max(0, this.anchorSongMs));
    const when = this.ctx.currentTime + Math.max(0, delaySec);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    src.connect(this.songGain);
    src.start(when, pos / 1000);
    this.source = src;
    this.anchorSongMs = pos;
    this.anchorCtxTime = when;
    this._playing = true;
    this.scheduledUntilMs = pos;
    this.startScheduler();
    return when;
  }

  setVolumes(song: number, metronome: number, preview: number): void {
    this.songGain.gain.value = song;
    this.metroGain.gain.value = metronome;
    this.previewGain.gain.value = preview;
  }

  setRate(rate: number): void {
    if (rate === this._rate) return;
    if (this._playing) {
      const pos = this.currentMs();
      this.stopSource();
      this._rate = rate;
      this.startSource(pos);
    } else this._rate = rate;
  }

  setLoop(loop: { enabled: boolean; startMs: number; endMs: number }): void {
    this.loop = { ...loop };
  }

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
    this.scheduledUntilMs = this.currentMs();
  }

  setPreview(on: boolean): void {
    this.previewOn = on;
    this.scheduledUntilMs = this.currentMs();
  }

  async play(): Promise<void> {
    if (!this.buffer || this._playing) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    let pos = this.anchorSongMs;
    if (this.loop.enabled && (pos < this.loop.startMs || pos >= this.loop.endMs)) pos = this.loop.startMs;
    if (pos >= this.durationMs) pos = 0;
    this.startSource(pos);
  }

  pause(): void {
    if (!this._playing) return;
    const pos = this.currentMs();
    this.stopSource();
    this.anchorSongMs = pos;
  }

  stop(): void {
    const wasPlaying = this._playing;
    if (wasPlaying) this.stopSource();
    this.anchorSongMs = this.loop.enabled ? this.loop.startMs : 0;
  }

  seek(ms: number): void {
    const target = Math.min(this.durationMs, Math.max(0, ms));
    if (this._playing) {
      this.stopSource();
      this.startSource(target);
    } else this.anchorSongMs = target;
  }

  private startSource(fromMs: number): void {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    src.connect(this.songGain);
    const when = this.ctx.currentTime + 0.01;
    src.start(when, fromMs / 1000);
    this.source = src;
    this.anchorSongMs = fromMs;
    this.anchorCtxTime = when;
    this._playing = true;
    this.scheduledUntilMs = fromMs;
    this.startScheduler();
  }

  private stopSource(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // 既に停止
      }
      this.source.disconnect();
      this.source = null;
    }
    this._playing = false;
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private startScheduler(): void {
    if (this.schedulerTimer !== null) window.clearInterval(this.schedulerTimer);
    this.schedulerTimer = window.setInterval(() => this.tick(), 40);
  }

  /** ループ端の処理・終端処理・クリックのスケジュール */
  private tick(): void {
    if (!this._playing) return;
    const now = this.currentMs();
    if (this.loop.enabled && this.loop.endMs > this.loop.startMs && now >= this.loop.endMs) {
      this.stopSource();
      this.startSource(this.loop.startMs);
      return;
    }
    if (now >= this.durationMs) {
      this.stopSource();
      this.anchorSongMs = this.durationMs;
      this.onEnded?.();
      return;
    }
    const lookaheadMs = 150 * this._rate;
    const until = now + lookaheadMs;
    if (this.metronomeOn) {
      const downbeats = new Set(this.options.getDownbeats());
      this.scheduleEvents(this.options.getBeats(), this.scheduledUntilMs, until, (ms) => this.click(this.songTimeToCtx(ms), downbeats.has(ms) ? 1600 : 1000, this.metroGain, 0.03));
    }
    if (this.previewOn) {
      this.scheduleEvents(this.options.getPreviewNotes(), this.scheduledUntilMs, until, (ms) => this.click(this.songTimeToCtx(ms), 2200, this.previewGain, 0.025));
    }
    this.scheduledUntilMs = until;
  }

  private songTimeToCtx(songMs: number): number {
    return this.anchorCtxTime + (songMs - this.anchorSongMs) / 1000 / this._rate;
  }

  private scheduleEvents(sorted: readonly number[], fromMs: number, toMs: number, fn: (ms: number) => void): void {
    // fromMs を超え toMs 以下のイベントを二分探索で取り出す
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= fromMs) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length && sorted[i]! <= toMs; i++) fn(sorted[i]!);
  }

  /** 合成クリック音（外部音源なし） */
  private click(ctxTime: number, freq: number, dest: GainNode, durationSec: number): void {
    const t = Math.max(this.ctx.currentTime, ctxTime);
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.8, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, t + durationSec);
    osc.connect(env);
    env.connect(dest);
    osc.start(t);
    osc.stop(t + durationSec + 0.01);
  }

  /** 即時の試聴音（ヒット追加時などのフィードバック） */
  tickNow(): void {
    this.click(this.ctx.currentTime, 2200, this.previewGain, 0.025);
  }

  destroy(): void {
    this.stopSource();
    void this.ctx.close();
  }
}
