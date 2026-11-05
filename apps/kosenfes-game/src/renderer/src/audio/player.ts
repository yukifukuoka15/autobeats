/**
 * 楽曲再生（renderer 側）。AudioContext の時計で開始時刻を予約し、
 * 実際の開始後に main へハンドシェイクと定期的な位置報告を送る。
 */
export interface LoadedAudio {
  buffer: AudioBuffer;
}

export class GamePlayer {
  readonly ctx: AudioContext;
  private readonly musicGain: GainNode;
  private readonly sfxGain: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private startAtCtx: number | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.musicGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain.connect(this.ctx.destination);
    this.sfxGain.connect(this.ctx.destination);
  }

  setVolumes(music: number, sfx: number): void {
    this.musicGain.gain.value = Math.min(1, Math.max(0, music));
    this.sfxGain.gain.value = Math.min(1, Math.max(0, sfx));
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** kosenfes-media:// からフェッチしてデコードする */
  async loadFromToken(token: string): Promise<LoadedAudio> {
    const res = await fetch(`kosenfes-media://audio/${token}`);
    if (!res.ok) throw new Error(`音声を取得できません（${res.status}）`);
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error('音声ファイルが空です');
    let buffer: AudioBuffer;
    try {
      buffer = await this.ctx.decodeAudioData(bytes);
    } catch {
      throw new Error('音声をデコードできません（非対応形式または破損）');
    }
    if (buffer.duration <= 0) throw new Error('音声の長さが 0 秒です');
    return { buffer };
  }

  /** 固定譜面モード用のクリック音（メトロノーム）を合成する */
  buildClickTrack(bpm: number, durationMs: number, firstBeatMs = 0): LoadedAudio {
    const sr = this.ctx.sampleRate;
    const frames = Math.ceil((durationMs / 1000) * sr);
    const buffer = this.ctx.createBuffer(1, frames, sr);
    const data = buffer.getChannelData(0);
    const beatSec = 60 / bpm;
    let n = 0;
    for (let t = firstBeatMs / 1000; t < durationMs / 1000; t += beatSec, n++) {
      const start = Math.round(t * sr);
      const freq = n % 4 === 0 ? 1320 : 880;
      const len = Math.round(0.03 * sr);
      for (let i = 0; i < len && start + i < frames; i++) {
        const tt = i / sr;
        data[start + i] = 0.4 * Math.exp(-tt / 0.008) * Math.sin(2 * Math.PI * freq * tt);
      }
    }
    return { buffer };
  }

  /** ctx 時刻 startAtCtx に再生を予約する */
  schedule(audio: LoadedAudio, startAtCtx: number): void {
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = audio.buffer;
    src.connect(this.musicGain);
    src.start(startAtCtx);
    this.source = src;
    this.startAtCtx = startAtCtx;
  }

  /** 楽曲時刻（ms）。未開始なら負の値 */
  songTimeMs(): number {
    if (this.startAtCtx === null) return Number.NEGATIVE_INFINITY;
    return (this.ctx.currentTime - this.startAtCtx) * 1000;
  }

  get scheduled(): boolean {
    return this.startAtCtx !== null;
  }

  stop(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {}
      this.source.disconnect();
      this.source = null;
    }
    this.startAtCtx = null;
  }

  /** 短い効果音（判定音） */
  playTick(kind: 'hit' | 'miss'): void {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = kind === 'hit' ? 'triangle' : 'sawtooth';
    osc.frequency.value = kind === 'hit' ? 1760 : 220;
    g.gain.setValueAtTime(0.25, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.09);
  }

  async close(): Promise<void> {
    this.stop();
    await this.ctx.close().catch(() => undefined);
  }
}
