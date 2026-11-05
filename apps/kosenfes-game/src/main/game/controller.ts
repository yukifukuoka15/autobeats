/**
 * プレイ全体の制御（main process）。セッション・デバイス・ライブラリ・ランキングを結び付ける。
 * Electron には依存せず、renderer への送信関数と音声トークン登録関数を注入する。
 */
import { JUDGE, NEON_HIT_GAME_ID, buildSongRankingKey, type ChorusSection, type LevelKey, type LevelNumber } from '@autobeats/chart-format';
import { randomUUID } from 'node:crypto';
import type { AbortReason, FinishedResult, PrepareResult, PreparedGame, SessionEvent, SessionSnapshot } from '../../shared/types';
import type { DeviceManager } from '../device/manager';
import type { ButtonDevice } from '../device/types';
import { buildFixedChart, fixedRankingKey } from '../games/registry';
import { reverifyEntry } from '../services/importPackage';
import type { LibraryStore } from '../services/library';
import { type RankingsStore, provisionalRank } from '../services/rankings';
import type { SettingsStore } from '../services/settings';
import { GameSession, type LedColor } from './session';

export interface ControllerDeps {
  settings: SettingsStore;
  library: LibraryStore;
  rankings: RankingsStore;
  devices: DeviceManager;
  /** renderer へ送る */
  emit: (channel: 'game:snapshot' | 'game:event' | 'game:finished' | 'device:led', payload: unknown) => void;
  registerAudioToken: (absolutePath: string) => string;
  revokeAudioToken: (token: string) => void;
  now?: () => number;
  tickIntervalMs?: number;
  snapshotIntervalMs?: number;
}

interface CurrentPlay {
  prepared: PreparedGame;
  trackId: string | null;
  audioSha256: string | null;
  started: boolean;
  result: FinishedResult | null;
  registered: boolean;
}

export class PlayController {
  private session: GameSession | null = null;
  private current: CurrentPlay | null = null;
  private device: ButtonDevice | null = null;
  private unsubscribe: (() => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  /** 設定を検証し、プレイ準備情報を返す。開始できない理由は日本語で列挙する */
  async prepare(): Promise<PrepareResult> {
    if (this.session && (this.session.state === 'countdown' || this.session.state === 'playing')) {
      return { ok: false, reasons: ['プレイ中です。'] };
    }
    this.cleanupCurrent();
    const settings = await this.deps.settings.get();
    const reasons: string[] = [];
    const device = this.deps.devices.get(settings.deviceId);
    if (!device) reasons.push('使用するボタンデバイスが選択されていません。');
    else if (device.kind === 'serial') reasons.push('実物ボタンは未接続です。仮想ボタンを選択してください。');

    const sessionId = randomUUID();
    if (settings.mode === 'fixed') {
      if (reasons.length > 0) return { ok: false, reasons };
      const chart = buildFixedChart();
      const prepared: PreparedGame = {
        ok: true,
        sessionId,
        mode: 'fixed',
        title: chart.title,
        level: null,
        notes: chart.notes,
        choruses: chart.choruses,
        durationMs: chart.durationMs,
        bpm: chart.bpm,
        countdownMs: JUDGE.countdownMs,
        approachMs: JUDGE.approachMs,
        audioToken: null,
        rankingKey: fixedRankingKey(),
        inputOffsetMs: settings.inputOffsetMs,
        musicVolume: settings.musicVolume,
        sfxVolume: settings.sfxVolume,
      };
      this.current = { prepared, trackId: null, audioSha256: null, started: false, result: null, registered: false };
      return prepared;
    }

    if (!settings.selectedTrackId || !settings.selectedAudioSha256) {
      reasons.push('楽曲が選択されていません。');
      return { ok: false, reasons };
    }
    const entry = await this.deps.library.find(settings.selectedTrackId, settings.selectedAudioSha256);
    if (!entry) {
      reasons.push('選択した楽曲がライブラリにありません。');
      return { ok: false, reasons };
    }
    const verified = await reverifyEntry(this.deps.library, entry);
    if (!verified.ok) {
      reasons.push(`譜面または音声が不正です: ${verified.errors.join(' / ')}`);
      return { ok: false, reasons };
    }
    const level = settings.level as LevelNumber;
    const levelKey = String(level) as LevelKey;
    const levelData = verified.chart.levels[levelKey];
    if (!levelData || levelData.notes.length === 0) reasons.push(`LEVEL ${level} に音符がありません。`);
    if (reasons.length > 0) return { ok: false, reasons };
    const token = this.deps.registerAudioToken(verified.audioPath);
    const prepared: PreparedGame = {
      ok: true,
      sessionId,
      mode: 'song',
      title: verified.chart.title,
      level,
      notes: levelData!.notes.map((n) => n.hitAtMs),
      choruses: verified.chart.choruses as ChorusSection[],
      durationMs: verified.chart.durationMs,
      bpm: verified.chart.bpm,
      countdownMs: JUDGE.countdownMs,
      approachMs: JUDGE.approachMs,
      audioToken: token,
      rankingKey: buildSongRankingKey({ gameId: NEON_HIT_GAME_ID, trackId: verified.chart.trackId, audioSha256: verified.chart.audioSha256, formatVersion: verified.chart.formatVersion, level }),
      inputOffsetMs: settings.inputOffsetMs,
      musicVolume: settings.musicVolume,
      sfxVolume: settings.sfxVolume,
    };
    this.current = { prepared, trackId: entry.trackId, audioSha256: entry.audioSha256, started: false, result: null, registered: false };
    return prepared;
  }

  /** カウントダウンを開始する（renderer は音声の準備を終えてから呼ぶ） */
  async start(sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const cur = this.current;
    if (!cur || cur.prepared.sessionId !== sessionId) return { ok: false, reason: 'プレイ準備がやり直されました。もう一度開始してください。' };
    if (cur.started) return { ok: false, reason: 'すでに開始しています。' };
    const settings = await this.deps.settings.get();
    let device: ButtonDevice;
    try {
      device = await this.deps.devices.acquire(settings.deviceId);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    this.device = device;
    const session = new GameSession({
      now: this.deps.now,
      onEvent: (e) => this.onSessionEvent(e),
      setLed: (color, ms) => device.setLed(color, ms),
    });
    this.session = session;
    this.unsubscribe.push(
      device.on('pressed', (e) => session.press({ sessionId, eventId: e.eventId, seq: e.seq, receivedAtMs: e.receivedAtMs })),
      device.on('released', (e) => session.release({ sessionId, eventId: e.eventId, seq: e.seq })),
      device.onLed((color) => this.deps.emit('device:led', { color })),
    );
    cur.started = true;
    session.start({
      sessionId,
      notes: cur.prepared.notes,
      durationMs: cur.prepared.durationMs,
      inputOffsetMs: cur.prepared.inputOffsetMs,
      requiresAudio: true,
      rankingEligible: true,
    });
    this.tickTimer = setInterval(() => session.tick(), this.deps.tickIntervalMs ?? 8);
    this.snapshotTimer = setInterval(() => this.deps.emit('game:snapshot', session.snapshot()), this.deps.snapshotIntervalMs ?? 33);
    this.deps.emit('game:snapshot', session.snapshot());
    return { ok: true };
  }

  audioStarted(sessionId: string, latencyMs: number): void {
    this.session?.audioStarted({ sessionId, latencyMs });
  }

  audioPosition(sessionId: string, songTimeMs: number): void {
    this.session?.audioPosition({ sessionId, songTimeMs });
  }

  audioFailed(sessionId: string, message: string): void {
    this.session?.audioFailed(sessionId, message);
  }

  abort(reason: AbortReason, message?: string): void {
    this.session?.abort(reason, message);
  }

  snapshot(): SessionSnapshot | null {
    return this.session?.snapshot() ?? null;
  }

  /** 仮想デバイスへの入力（renderer のキーボードから） */
  virtualInput(kind: 'pressed' | 'released'): void {
    this.deps.devices.virtual.inject(kind);
  }

  isTrackInUse(trackId: string, sha: string): boolean {
    const s = this.session;
    if (!s || !this.current) return false;
    if (s.state !== 'countdown' && s.state !== 'playing') return false;
    return this.current.trackId === trackId && this.current.audioSha256 === sha;
  }

  getResult(sessionId: string): FinishedResult | null {
    if (!this.current || this.current.prepared.sessionId !== sessionId) return null;
    return this.current.result;
  }

  /** 正常終了した検証済みプレイだけランキングへ登録する */
  async registerName(sessionId: string, name: string): Promise<{ ok: true; rank: number | null } | { ok: false; reason: string }> {
    const cur = this.current;
    if (!cur || cur.prepared.sessionId !== sessionId || !cur.result) return { ok: false, reason: '登録できるプレイ結果がありません。' };
    if (!cur.result.rankingEligible) return { ok: false, reason: 'このプレイはランキング対象外です。' };
    if (cur.registered) return { ok: false, reason: 'すでに登録済みです。' };
    const r = await this.deps.rankings.register(cur.result.rankingKey, {
      name,
      score: cur.result.score,
      maxCombo: cur.result.maxCombo,
      counts: cur.result.counts,
    });
    cur.registered = true;
    return { ok: true, rank: r.rank };
  }

  private onSessionEvent(e: SessionEvent): void {
    this.deps.emit('game:event', e);
    if (e.kind === 'state' && (e.state === 'finished' || e.state === 'aborted')) {
      void this.finalize();
    }
  }

  private async finalize(): Promise<void> {
    const session = this.session;
    const cur = this.current;
    this.stopTimers();
    if (!session || !cur) return;
    const snapshot = session.snapshot();
    this.deps.emit('game:snapshot', snapshot);
    const eligible = session.rankingEligible;
    let rank: number | null = null;
    if (eligible) {
      const rows = await this.deps.rankings.get(cur.prepared.rankingKey);
      rank = provisionalRank(rows, session.score);
    }
    cur.result = {
      sessionId: cur.prepared.sessionId,
      score: session.score,
      maxCombo: session.maxCombo,
      counts: { ...session.counts },
      emptyPresses: session.emptyPresses,
      rankingEligible: eligible,
      rankingKey: cur.prepared.rankingKey,
      provisionalRank: rank,
      title: cur.prepared.title,
      level: cur.prepared.level,
    };
    this.releaseDevice();
    this.deps.emit('game:finished', { result: cur.result, abortReason: session.abortReason ?? null, abortMessage: session.abortMessage ?? null });
  }

  private stopTimers(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.tickTimer = null;
    this.snapshotTimer = null;
  }

  private releaseDevice(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    if (this.device) {
      this.device.setLed('off' as LedColor, 0);
      this.device = null;
    }
  }

  private cleanupCurrent(): void {
    if (this.current?.prepared.audioToken) this.deps.revokeAudioToken(this.current.prepared.audioToken);
    this.current = null;
    this.session = null;
    this.stopTimers();
    this.releaseDevice();
  }

  /** ウィンドウ終了時など。進行中なら中断して全リソースを破棄する */
  dispose(): void {
    if (this.session && (this.session.state === 'countdown' || this.session.state === 'playing')) {
      this.session.abort('window-closed');
    }
    this.stopTimers();
    this.releaseDevice();
    if (this.current?.prepared.audioToken) this.deps.revokeAudioToken(this.current.prepared.audioToken);
    this.current = null;
    this.session = null;
  }
}
