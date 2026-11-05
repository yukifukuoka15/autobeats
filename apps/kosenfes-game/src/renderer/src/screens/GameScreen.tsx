import { useCallback, useEffect, useRef, useState } from 'react';
import { SYNC, type Judgement, type EarlyLate } from '@autobeats/chart-format';
import type { GameSettings, PreparedGame, SessionSnapshot } from '../../../shared/types';
import { api } from '../api';
import { GamePlayer, type LoadedAudio } from '../audio/player';
import { LaneCanvas } from '../components/LaneCanvas';
import type { FinishedPayload } from '../App';

interface Props {
  settings: GameSettings;
  onFinished: (p: FinishedPayload) => void;
}

type Phase = 'idle' | 'preparing' | 'ready' | 'countdown' | 'playing' | 'ending';

interface JudgementDisplay {
  judgement: Judgement | 'EMPTY';
  earlyLate: EarlyLate;
  at: number;
}

const VIRTUAL_KEYS = new Set(['Space', 'KeyJ', 'KeyF']);
const LED_COLORS: Record<string, string> = { white: '#ffffff', yellow: '#ffe45c', orange: '#ffa03a', purple: '#b26bff', 'dim-red': '#5a1a1a', off: '#1b2130' };

export function GameScreen({ settings, onFinished }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [prepared, setPrepared] = useState<PreparedGame | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [judgement, setJudgement] = useState<JudgementDisplay | null>(null);
  const [led, setLed] = useState('off');
  const [countdownValue, setCountdownValue] = useState<number | null>(null);
  const playerRef = useRef<GamePlayer | null>(null);
  const audioRef = useRef<LoadedAudio | null>(null);
  const startAtRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const sessionRef = useRef<string | null>(null);
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const finishedRef = useRef(false);

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearInterval(t);
    timersRef.current = [];
  }, []);

  const teardownAudio = useCallback(() => {
    clearTimers();
    playerRef.current?.stop();
    startAtRef.current = null;
  }, [clearTimers]);

  /** プレイ準備: 設定検証と音声のデコード */
  const prepare = useCallback(async () => {
    setPhaseBoth('preparing');
    setReasons([]);
    setSnapshot(null);
    setJudgement(null);
    finishedRef.current = false;
    const r = await api.game.prepare();
    if (!r.ok) {
      setReasons(r.reasons);
      setPrepared(null);
      setPhaseBoth('idle');
      return;
    }
    try {
      if (!playerRef.current) playerRef.current = new GamePlayer();
      const player = playerRef.current;
      player.setVolumes(r.musicVolume, r.sfxVolume);
      await player.resume();
      audioRef.current = r.audioToken ? await player.loadFromToken(r.audioToken) : player.buildClickTrack(r.bpm, r.durationMs, 3000);
      setPrepared(r);
      sessionRef.current = r.sessionId;
      setPhaseBoth('ready');
    } catch (err) {
      setReasons([`音声を準備できません: ${(err as Error).message}`]);
      setPrepared(null);
      setPhaseBoth('idle');
    }
  }, [setPhaseBoth]);

  useEffect(() => {
    // 設定変更のたびに準備し直す
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void prepare();
    return () => {
      teardownAudio();
      if (phaseRef.current === 'countdown' || phaseRef.current === 'playing') void api.game.abort();
      void playerRef.current?.close();
      playerRef.current = null;
    };
    // settings が変わったら準備し直す
  }, [prepare, teardownAudio, settings.mode, settings.selectedTrackId, settings.selectedAudioSha256, settings.level, settings.deviceId, settings.inputOffsetMs]);

  /** 開始: main でカウントダウン開始 → 音声を予約 → 開始後にハンドシェイク */
  const start = useCallback(async () => {
    const p = prepared;
    const player = playerRef.current;
    const audio = audioRef.current;
    if (!p || !player || !audio || phaseRef.current !== 'ready') return;
    await player.resume();
    const r = await api.game.start(p.sessionId);
    if (!r.ok) {
      setReasons([r.reason]);
      return;
    }
    const startAt = player.ctx.currentTime + p.countdownMs / 1000;
    try {
      player.schedule(audio, startAt);
    } catch (err) {
      await api.game.audioFailed(p.sessionId, `音声の開始に失敗しました: ${(err as Error).message}`);
      return;
    }
    startAtRef.current = startAt;
    setPhaseBoth('countdown');
    let handshook = false;
    const poll = setInterval(() => {
      const now = player.ctx.currentTime;
      const remaining = startAt - now;
      setCountdownValue(remaining > 0 ? Math.ceil(remaining) : null);
      if (!handshook && now >= startAt) {
        handshook = true;
        const latencyMs = (now - startAt) * 1000;
        void api.game.audioStarted(p.sessionId, latencyMs);
        setPhaseBoth('playing');
      }
    }, 5);
    const report = setInterval(() => {
      if (startAtRef.current === null) return;
      const songTime = (player.ctx.currentTime - startAtRef.current) * 1000;
      if (songTime >= 0) void api.game.audioPosition(p.sessionId, songTime);
    }, SYNC.driftReportIntervalMs);
    timersRef.current.push(poll, report);
  }, [prepared, setPhaseBoth]);

  const showJudgement = useCallback((j: JudgementDisplay) => {
    setJudgement(j);
    setTimeout(() => setJudgement((cur) => (cur?.at === j.at ? null : cur)), 600);
  }, []);

  // main からのイベント購読
  useEffect(() => {
    const offSnap = api.game.onSnapshot((s) => {
      if (s.sessionId === sessionRef.current) setSnapshot(s);
    });
    const offEvent = api.game.onEvent((e) => {
      if (e.sessionId !== sessionRef.current) return;
      if (e.kind === 'judgement') {
        showJudgement({ judgement: e.judgement, earlyLate: e.earlyLate, at: performance.now() });
        playerRef.current?.playTick(e.judgement === 'MISS' ? 'miss' : 'hit');
      } else if (e.kind === 'empty-press') {
        showJudgement({ judgement: 'EMPTY', earlyLate: null, at: performance.now() });
      }
    });
    const offFinished = api.game.onFinished((payload) => {
      if (payload.result.sessionId !== sessionRef.current || finishedRef.current) return;
      finishedRef.current = true;
      setPhaseBoth('ending');
      teardownAudio();
      onFinished(payload);
    });
    const offLed = api.device.onLed(({ color }) => setLed(color));
    return () => {
      offSnap();
      offEvent();
      offFinished();
      offLed();
    };
  }, [onFinished, setPhaseBoth, teardownAudio, showJudgement]);

  // 仮想ボタン（キーボード）
  useEffect(() => {
    if (settings.deviceId !== 'virtual-keyboard') return;
    const down = (ev: KeyboardEvent) => {
      if (!VIRTUAL_KEYS.has(ev.code) || ev.repeat) return;
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      ev.preventDefault();
      void api.game.virtualInput('pressed');
    };
    const up = (ev: KeyboardEvent) => {
      if (!VIRTUAL_KEYS.has(ev.code)) return;
      ev.preventDefault();
      void api.game.virtualInput('released');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [settings.deviceId]);

  const songTime = useCallback(() => {
    const player = playerRef.current;
    if (!player || startAtRef.current === null) return Number.NEGATIVE_INFINITY;
    return (player.ctx.currentTime - startAtRef.current) * 1000;
  }, []);

  return (
    <div className="game" data-testid="game-screen" data-phase={phase}>
      <div className="row">
        <strong data-testid="game-title">{prepared ? `${prepared.title}${prepared.level ? ` / LEVEL ${prepared.level}` : ' / 固定譜面'}` : '—'}</strong>
        <span className="muted">
          <span className="led" data-testid="led" style={{ background: LED_COLORS[led] ?? '#333' }} />
          LED
        </span>
        <div className="spacer" />
        <button data-testid="prepare-button" onClick={() => void prepare()} disabled={phase === 'preparing' || phase === 'countdown' || phase === 'playing'}>
          再準備
        </button>
        <button data-testid="start-button" className="primary" onClick={() => void start()} disabled={phase !== 'ready'}>
          開始
        </button>
        <button data-testid="abort-button" className="danger" onClick={() => void api.game.abort()} disabled={phase !== 'countdown' && phase !== 'playing'}>
          中断
        </button>
      </div>
      {reasons.length > 0 && (
        <div className="msg error" data-testid="start-reasons">
          開始できません: {reasons.join(' / ')}
        </div>
      )}
      <div className="game-hud">
        <span className="score" data-testid="score">
          {snapshot?.score ?? 0}
        </span>
        <span className="combo" data-testid="combo">
          {snapshot?.combo ?? 0} COMBO
        </span>
        <span className="muted" data-testid="state">
          {phase === 'idle' && '準備されていません'}
          {phase === 'preparing' && '準備中…'}
          {phase === 'ready' && '準備完了'}
          {phase === 'countdown' && 'カウントダウン'}
          {phase === 'playing' && 'プレイ中'}
          {phase === 'ending' && '終了'}
        </span>
      </div>
      <div className="lane-wrap">
        <LaneCanvas prepared={prepared} snapshot={snapshot} songTime={songTime} />
        {countdownValue !== null && phase === 'countdown' && (
          <div className="countdown" data-testid="countdown">
            {countdownValue}
          </div>
        )}
        {judgement && (
          <div className={`judgement j-${judgement.judgement}`} data-testid="judgement">
            {judgement.judgement === 'EMPTY' ? '空押し' : judgement.judgement}
            {judgement.earlyLate && <span className="sub">{judgement.earlyLate}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
