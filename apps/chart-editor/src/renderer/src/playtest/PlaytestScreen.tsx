import { JUDGE, LEVEL_KEYS, MASH, formatTimecode, type LevelKey } from '@autobeats/chart-format';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { controller } from '../controller';
import { editorStore, useDocument } from '../store/editorStore';
import { LEVEL_COLORS } from '../timeline/draw';
import { PLAYTEST_COUNTDOWN_MS, PLAYTEST_KEYS, PlaytestEngine, playtestResultLabel, type LaneResult } from './engine';

type Phase = 'ready' | 'countdown' | 'playing' | 'finished';

/** 判定枠の中心位置（レーン幅に対する割合。メインアプリと同じ左寄り） */
const JUDGE_X_RATIO = 0.15;
const BURST_MS = 320;
const MISS_FADE_MS = 500;
const LANE_HEIGHT = 120;
const COLORS = { lane: '#1c0707', wall: '#de2121', wallDim: '#660d0d', pellet: '#3a3a10', ballCore: 'rgba(255,255,255,0.55)', ring: '#e8e8ea', PERFECT: '#ffffff', GOOD: '#ffff00', BAD: '#ffb852', MISS: '#ff2a2a' } as const;

/**
 * エディター内プレイテスト。4 レーンを同時に試奏する（Q / W / O / P）。
 * 楽曲時刻の正本はトランスポートの音声時計。判定はエンジン（chart-format の共通判定）で行い、描画には使わない。
 */
export function PlaytestScreen() {
  const doc = useDocument();
  const [phase, setPhase] = useState<Phase>('ready');
  const [inputOffsetMs, setInputOffsetMs] = useState(0);
  const [fromPlayhead, setFromPlayhead] = useState(true);
  const [, force] = useState(0);
  // 可変状態は ref で持ち（ハンドラーから最新を参照）、描画に使う値は state へ写す
  const engineRef = useRef<PlaytestEngine | null>(null);
  const [engine, setEngine] = useState<PlaytestEngine | null>(null);
  const [startCtx, setStartCtx] = useState(0);
  const startMsRef = useRef(0);
  const held = useRef<Set<LevelKey>>(new Set());
  const [heldKeys, setHeldKeys] = useState<ReadonlySet<LevelKey>>(new Set());
  const reduceMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const songNow = useCallback((): number => controller.currentMs(), []);

  const stopAll = useCallback(() => {
    controller.pause();
    controller.seek(startMsRef.current);
    controller.transport.setRate(editorStore.getState().playback.rate);
  }, []);

  const close = useCallback(() => {
    stopAll();
    editorStore.setPlaytest({ open: false });
  }, [stopAll]);

  const start = useCallback(() => {
    if (!doc.audio) return;
    const startMs = fromPlayhead ? Math.round(controller.currentMs()) : 0;
    startMsRef.current = startMs;
    controller.scrub.cancel();
    controller.pause();
    controller.transport.setRate(1);
    controller.seek(startMs);
    const e = new PlaytestEngine({ ...doc.levels, '4': { notes: [] } }, { startMs, durationMs: doc.audio.durationMs, inputOffsetMs });
    engineRef.current = e;
    setEngine(e);
    held.current.clear();
    setHeldKeys(new Set());
    setStartCtx(controller.transport.playScheduled(PLAYTEST_COUNTDOWN_MS / 1000));
    setPhase('countdown');
  }, [doc, fromPlayhead, inputOffsetMs]);

  // キー入力（Q/W/O/P）。OS のリピートは無視し、解放で次の押下を許可する
  useEffect(() => {
    const keyToLevel = (e: KeyboardEvent): LevelKey | null => {
      const k = e.key.toLowerCase();
      // LEVEL 1 は Q とスペースキーの両方で反応する
      if (k === ' ' || e.code === 'Space') return '1';
      for (const level of LEVEL_KEYS.filter((k) => k !== '4')) if (PLAYTEST_KEYS[level] === k) return level;
      return null;
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      const level = keyToLevel(e);
      if (!level) return;
      e.preventDefault();
      if (e.repeat || held.current.has(level)) return;
      held.current.add(level);
      setHeldKeys(new Set(held.current));
      const eng = engineRef.current;
      if (phase === 'playing' && eng) {
        eng.press(level, songNow());
        force((n) => n + 1);
      } else if (phase === 'ready' && level === '1') start();
    };
    const up = (e: KeyboardEvent) => {
      const level = keyToLevel(e);
      if (!level) return;
      held.current.delete(level);
      setHeldKeys(new Set(held.current));
      engineRef.current?.release(level);
      force((n) => n + 1);
    };
    const cancel = () => {
      for (const level of held.current) engineRef.current?.release(level);
      held.current.clear();
      setHeldKeys(new Set());
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', cancel);
    };
  }, [phase, start, close, songNow]);

  // 進行（カウントダウン → 再生 → 終了）。楽曲時刻は音声時計から毎フレーム読む
  useEffect(() => {
    if (phase !== 'countdown' && phase !== 'playing') return;
    let raf = 0;
    const loop = () => {
      const eng = engineRef.current;
      if (!eng) return;
      const ctxNow = controller.transport.ctx.currentTime;
      if (phase === 'countdown' && ctxNow >= startCtx) {
        setPhase('playing');
        return;
      }
      if (phase === 'playing') {
        const t = songNow();
        eng.tick(t);
        if (eng.isFinished(t) || !controller.isPlaying()) {
          controller.pause();
          controller.transport.setRate(editorStore.getState().playback.rate);
          setPhase('finished');
          return;
        }
      }
      force((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, songNow, startCtx]);

  // アンマウント時は必ず停止
  useEffect(() => () => stopAll(), [stopAll]);

  const now = songNow();
  const countdownLeft = Math.max(0, Math.ceil(startCtx - controller.transport.ctx.currentTime));
  const totals = engine?.totals();
  return (
    <div className="playtest" data-testid="playtest" data-phase={phase}>
      <h1 className="pt-title">PLAY TEST — {doc.title || '無題'}</h1>
      <div className="pt-hud">
        <div className="pt-card">
          <div className="big-label">SCORE</div>
          <div className="big-number" data-testid="playtest-score">
            {engine?.score ?? 0}
          </div>
        </div>
        <div className="pt-card">
          <div className="big-label">COMBO</div>
          <div className="big-number white" data-testid="playtest-combo">
            {engine?.combo ?? 0}
          </div>
        </div>
        <div className="pt-card">
          <div className="big-label">TIME</div>
          <div className="big-number white" data-testid="playtest-songtime" data-ms={Math.round(now)}>
            {formatTimecode(now, false)}
          </div>
        </div>
        <div className="pt-card">
          <div className="big-label">PERFECT / GOOD / BAD / MISS / 空押し</div>
          <div className="big-number white" style={{ fontSize: 16 }} data-testid="playtest-counts">
            {totals ? `${totals.PERFECT} / ${totals.GOOD} / ${totals.BAD} / ${totals.MISS} / ${totals.empty}` : '- / - / - / - / -'}
          </div>
        </div>
      </div>
      <div className="pt-lanes">
        {LEVEL_KEYS.filter((k) => k !== '4').map((level) => (
          <Lane key={level} level={level} engine={engine} phase={phase} now={now} heldKey={heldKeys.has(level)} reduceMotion={reduceMotion} />
        ))}
      </div>
      {phase === 'countdown' && (
        <div className="pt-center">
          <div className="countdown" key={countdownLeft} data-testid="playtest-countdown">
            {countdownLeft}
          </div>
        </div>
      )}
      {phase === 'ready' && (
        <div className="pt-center">
          <div className="pt-ready pt-card">
            <div className="insert">PRESS START</div>
            <p className="hint">
              LEVEL 1 = Q または スペース、LEVEL 2 = W、LEVEL 3 = O、LEVEL 4 = P。{PLAYTEST_COUNTDOWN_MS / 1000} 秒のカウントダウン後に楽曲が始まります。連打（面）は区間内で同じキーを連打します（{MASH.requiredPressIntervalMs}ms に 1 回で満点、1 回ごとに +{MASH.bonusPerPress}）。Esc で終了。
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="accent" data-testid="btn-playtest-start" onClick={start} disabled={!doc.audio}>
                スタート
              </button>
              <button data-testid="btn-playtest-close" onClick={close}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
      {phase === 'finished' && engine && totals && (
        <div className="pt-result" data-testid="playtest-result">
          <div className="pt-card">
            <div className="big-label">RESULT</div>
            <div className="big-number" data-testid="playtest-result-score">
              {engine.score}
            </div>
            <table>
              <tbody>
                <tr>
                  <th>MAX COMBO</th>
                  <td>{engine.maxCombo}</td>
                </tr>
                <tr>
                  <th>PERFECT</th>
                  <td>{totals.PERFECT}</td>
                </tr>
                <tr>
                  <th>GOOD</th>
                  <td>{totals.GOOD}</td>
                </tr>
                <tr>
                  <th>BAD</th>
                  <td>{totals.BAD}</td>
                </tr>
                <tr>
                  <th>MISS</th>
                  <td>{totals.MISS}</td>
                </tr>
                <tr>
                  <th>空押し</th>
                  <td>{totals.empty}</td>
                </tr>
                <tr>
                  <th>ヒット数</th>
                  <td>{engine.totalNotes}</td>
                </tr>
              </tbody>
            </table>
            <div className="row">
              <button className="accent" data-testid="btn-playtest-retry" onClick={() => setPhase('ready')}>
                もう一度
              </button>
              <button data-testid="btn-playtest-close" onClick={close}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="pt-bar">
        <label>
          入力遅延補正 (ms)
          <input
            type="number"
            min={JUDGE.inputOffset.minMs}
            max={JUDGE.inputOffset.maxMs}
            step={JUDGE.inputOffset.stepMs}
            value={inputOffsetMs}
            disabled={phase !== 'ready'}
            onChange={(e) => setInputOffsetMs(Math.max(JUDGE.inputOffset.minMs, Math.min(JUDGE.inputOffset.maxMs, Math.round(Number(e.target.value) / 10) * 10)))}
            data-testid="playtest-offset"
          />
        </label>
        <label className="inline">
          <input type="checkbox" checked={fromPlayhead} disabled={phase !== 'ready'} onChange={(e) => setFromPlayhead(e.target.checked)} data-testid="playtest-from-playhead" /> 再生ヘッド位置から始める（オフで曲頭から）
        </label>
        <span className="dim">
          球は右から左へ {JUDGE.approachMs}ms で流れます。判定: PERFECT ±{JUDGE.perfectMs} / GOOD ±{JUDGE.goodMs} / BAD ±{JUDGE.badMs}ms
        </span>
        {(phase === 'countdown' || phase === 'playing') && (
          <button className="danger small" data-testid="btn-playtest-stop" onClick={close}>
            中止（Esc）
          </button>
        )}
      </div>
    </div>
  );
}

function Lane({ level, engine, phase, now, heldKey, reduceMotion }: { level: LevelKey; engine: PlaytestEngine | null; phase: Phase; now: number; heldKey: boolean; reduceMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lane = engine?.lanes[level] ?? null;
  const result: LaneResult | null = lane?.lastResult ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, wrap.clientWidth);
    const h = LANE_HEIGHT;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // レーン（黒地に赤い二重線の壁、下辺に薄いペレット）
    ctx.fillStyle = COLORS.lane;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = COLORS.wall;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
    ctx.strokeStyle = COLORS.wallDim;
    ctx.lineWidth = 2;
    ctx.strokeRect(7, 7, w - 14, h - 14);
    ctx.fillStyle = COLORS.pellet;
    for (let x = 16; x < w - 8; x += 24) ctx.fillRect(x, h - 14, 3, 3);
    const judgeX = Math.round(w * JUDGE_X_RATIO);
    const cy = Math.round(h / 2) - 2;
    const r = Math.max(10, Math.min(h * 0.32, 28));
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.ring;
    ctx.beginPath();
    ctx.arc(judgeX, cy, r + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.wall;
    ctx.beginPath();
    ctx.arc(judgeX, cy, r + 12, 0, Math.PI * 2);
    ctx.stroke();
    if (!lane || phase === 'ready') return;
    const travel = JUDGE.approachMs;
    const span = w - judgeX;
    const ballR = r * 0.8;
    const color = LEVEL_COLORS[level];
    for (const n of lane.notes) {
      const appearAt = n.hitAtMs - travel;
      if (now < appearAt) break;
      const x = judgeX + ((n.hitAtMs - now) / travel) * span;
      if (n.durationMs > 0) {
        // 連打: 両端が半円の面。判定枠を通過している間は押下回数に応じて明るくする
        const x1 = judgeX + ((n.hitAtMs + n.durationMs - now) / travel) * span;
        if (x1 < -ballR) continue;
        const active = n.judgement === null && now >= n.hitAtMs - 80 && now <= n.hitAtMs + n.durationMs + 80;
        ctx.globalAlpha = n.judgement !== null ? 0.25 : 1;
        drawCapsule(ctx, x, x1, cy, ballR, color, active);
        ctx.globalAlpha = 1;
        continue;
      }
      if (n.judgement === null) {
        if (x < -ballR) continue;
        drawBall(ctx, x, cy, ballR, color);
        continue;
      }
      const since = now - (n.judgedAtMs ?? n.hitAtMs);
      if (n.judgement === 'MISS') {
        if (reduceMotion || since > MISS_FADE_MS || x < -ballR) continue;
        ctx.globalAlpha = Math.max(0, 1 - since / MISS_FADE_MS);
        drawBall(ctx, x, cy, ballR, color);
        ctx.globalAlpha = 1;
        continue;
      }
      if (reduceMotion || since > BURST_MS) continue;
      const t = Math.max(0, since / BURST_MS);
      ctx.globalAlpha = 1 - t;
      drawBall(ctx, judgeX, cy, ballR * (1 - t * 0.7), color);
      ctx.strokeStyle = COLORS[n.judgement];
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(judgeX, cy, r + 6 + t * r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  });

  return (
    <div className="pt-lane" data-testid={`playtest-lane-${level}`}>
      <div className="pt-lane-head" style={{ color: LEVEL_COLORS[level] }}>
        LEVEL {level}
        <br />
        <span className={`key ${heldKey ? 'held' : ''}`}>{PLAYTEST_KEYS[level].toUpperCase()}</span>
        {level === '1' && <span className={`key ${heldKey ? 'held' : ''}`} style={{ marginLeft: 4 }}>SPACE</span>}
        <span className="dim" style={{ marginLeft: 8, fontSize: 8 }}>
          {lane ? `${lane.notes.length}音` : ''}
        </span>
      </div>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <canvas ref={canvasRef} />
        {result && result.kind === 'EMPTY' && (
          <div key={result.seq} className="neon-empty" data-testid={`playtest-judge-${level}`} data-kind="EMPTY">
            {playtestResultLabel('EMPTY', null)}
          </div>
        )}
        {result && result.kind !== 'EMPTY' && (
          <div key={result.seq} className={`neon-judge ${result.kind.toLowerCase()}`} style={{ left: `${JUDGE_X_RATIO * 100}%` }} data-testid={`playtest-judge-${level}`} data-kind={result.kind} data-presses={result.presses ?? 0}>
            {playtestResultLabel(result.kind, result.earlyLate, result.presses ?? 0)}
          </div>
        )}
      </div>
    </div>
  );
}

/** 連打の面（両端が半円、中間が長方形） */
function drawCapsule(ctx: CanvasRenderingContext2D, x0: number, x1: number, cy: number, r: number, color: string, active: boolean): void {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  ctx.beginPath();
  if (right - left <= 2 * r) ctx.arc((left + right) / 2, cy, r, 0, Math.PI * 2);
  else {
    ctx.arc(left + r, cy, r, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.lineTo(right - r, cy - r);
    ctx.arc(right - r, cy, r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.globalAlpha = ctx.globalAlpha * (active ? 0.9 : 0.5);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = active ? 4 : 2;
  ctx.strokeStyle = active ? '#ffffff' : color;
  ctx.stroke();
}

function drawBall(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.ballCore;
  ctx.fillRect(Math.round(x - r * 0.45), Math.round(y - r * 0.55), Math.max(2, Math.round(r * 0.3)), Math.max(2, Math.round(r * 0.3)));
}
