import { useEffect, useRef } from 'react';
import type { PreparedGame, SessionSnapshot } from '../../../shared/types';

interface Props {
  prepared: PreparedGame | null;
  snapshot: SessionSnapshot | null;
  /** 楽曲時刻（ms）。未開始なら -Infinity */
  songTime: () => number;
}

const STATE_COLORS = ['#38e8ff', '#ffffff', '#ffe45c', '#ffa03a', '#ff5e6c'];

/** 右から左へ球が流れるレーン。描画は音声時計の楽曲時刻だけを参照する */
export function LaneCanvas({ prepared, snapshot, songTime }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const snapshotRef = useRef(snapshot);
  const preparedRef = useRef(prepared);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    preparedRef.current = prepared;
  }, [prepared]);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let raf = 0;
    const draw = () => {
      const p = preparedRef.current;
      const s = snapshotRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t = songTime();
      // 背景（サビは控えめな色味）
      let inChorus = false;
      if (p && Number.isFinite(t)) for (const c of p.choruses) if (t >= c.startMs && t < c.endMs) inChorus = true;
      ctx.fillStyle = inChorus ? '#160a1c' : '#05070b';
      ctx.fillRect(0, 0, w, h);
      const laneY = h * 0.55;
      const lineX = w * 0.18;
      const travel = w - lineX;
      ctx.strokeStyle = '#1f2838';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, laneY);
      ctx.lineTo(w, laneY);
      ctx.stroke();
      // 判定ライン
      ctx.strokeStyle = '#38e8ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(lineX, laneY - 60);
      ctx.lineTo(lineX, laneY + 60);
      ctx.stroke();
      if (!reduced) {
        ctx.shadowColor = '#38e8ff';
        ctx.shadowBlur = 14;
      }
      ctx.beginPath();
      ctx.arc(lineX, laneY, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (!p || !Number.isFinite(t)) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const approach = p.approachMs;
      const states = s?.noteStates;
      const r = 16;
      for (let i = 0; i < p.notes.length; i++) {
        const hit = p.notes[i]!;
        const dt = hit - t;
        if (dt > approach + 200) break;
        const state = states?.[i] ?? 0;
        if (dt < -400) continue;
        if (state !== 0 && dt < -60) continue; // 判定済みはすぐ消える
        const x = lineX + (dt / approach) * travel;
        if (x < -r || x > w + r) continue;
        ctx.beginPath();
        ctx.fillStyle = STATE_COLORS[state] ?? STATE_COLORS[0]!;
        ctx.globalAlpha = state === 0 ? 1 : 0.5;
        ctx.arc(x, laneY, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // 進行バー
      const progress = Math.max(0, Math.min(1, t / p.durationMs));
      ctx.fillStyle = '#2a3245';
      ctx.fillRect(0, h - 6, w, 6);
      ctx.fillStyle = '#ff4fd8';
      ctx.fillRect(0, h - 6, w * progress, 6);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [songTime, reduced]);

  return <canvas ref={ref} data-testid="lane-canvas" />;
}
