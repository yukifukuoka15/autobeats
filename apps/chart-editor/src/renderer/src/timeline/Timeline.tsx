import type { LevelKey } from '@autobeats/chart-format';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { controller } from '../controller';
import { checkPlacement, findNoteIssues } from '../store/document';
import { editorStore, runtime, useDocument, useEditorState } from '../store/editorStore';
import { drawTimeline } from './draw';
import { buildLanes, clampScroll, laneAt, makeScale, msOf, totalHeight, visibleRange, xOf, zoomAround, type Lane } from './geometry';
import { buildSnapGrid, snapToGrid } from './snap';
import { SCRUB } from '../scrub/constants';
import { usePlayhead } from '../store/playhead';

type DragState =
  | { kind: 'none' }
  | { kind: 'scrub' }
  | { kind: 'note-move'; level: LevelKey; ids: Set<string>; startMs: number; anchorNoteMs: number; moved: boolean }
  | { kind: 'marquee'; x0: number; y0: number; additive: boolean }
  | { kind: 'chorus-move'; id: string; startMs: number; origStart: number; origEnd: number }
  | { kind: 'chorus-resize'; id: string; edge: 'start' | 'end'; origStart: number; origEnd: number }
  | { kind: 'chorus-new'; startMs: number };

const NOTE_HIT_PX = 5;
const EDGE_HIT_PX = 6;

export function Timeline() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const doc = useDocument();
  const view = useEditorState((s) => s.view);
  const peaksVersion = useEditorState((s) => s.peaksVersion);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const [focused, setFocused] = useState(false);
  const scrub = useEditorState((s) => s.scrub);
  const { playing } = usePlayhead();
  const dragRef = useRef<DragState>({ kind: 'none' });
  const hoverRef = useRef<number | null>(null);
  const altRef = useRef(false);
  const lanes = useMemo(() => buildLanes(view.visibleLevels), [view.visibleLevels]);
  const height = totalHeight(lanes);
  const durationMs = doc.audio?.durationMs ?? 0;

  const issueIds = useMemo(() => new Set(findNoteIssues(doc).map((i) => `${i.level}:${i.id}`)), [doc]);
  const grid = useMemo(() => buildSnapGrid(doc.analysis, view.snapTarget, doc.bpm, doc.offsetMs, durationMs), [doc.analysis, view.snapTarget, doc.bpm, doc.offsetMs, durationMs]);
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const snap = useCallback(
    (ms: number, force?: boolean) => {
      const enabled = force ?? (view.snapEnabled && !altRef.current);
      return enabled ? snapToGrid(ms, grid) : Math.round(ms);
    },
    [grid, view.snapEnabled],
  );

  // リサイズ監視
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(100, Math.floor(el.clientWidth)), h: height }));
    ro.observe(el);
    setSize({ w: Math.max(100, Math.floor(el.clientWidth)), h: height });
    return () => ro.disconnect();
  }, [height]);

  // 描画ループ
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = size.w;
      const h = height;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const state = editorStore.getState();
        drawTimeline({
          ctx,
          width: w,
          height: h,
          dpr,
          lanes,
          scale: makeScale(state.view.zoomPxPerSec, state.view.scrollMs),
          doc: editorStore.doc,
          state,
          peaks: runtime.peaks,
          playheadMs: controller.currentMs(),
          issueIds,
          hoverMs: hoverRef.current,
          reducedMotion,
        });
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [size.w, height, lanes, issueIds, reducedMotion, peaksVersion]);

  // 再生中は再生ヘッドを追従
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!controller.isPlaying()) return;
      const s = editorStore.getState();
      const scale = makeScale(s.view.zoomPxPerSec, s.view.scrollMs);
      const x = xOf(scale, controller.currentMs());
      if (x > size.w * 0.9 || x < 0) {
        editorStore.setView({ scrollMs: clampScroll(controller.currentMs() - size.w * 0.1 / scale.pxPerMs, s.view.zoomPxPerSec, durationMs, size.w) });
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [size.w, durationMs]);

  // スクラブ中は再生ヘッドが表示幅の端 10% に入ったときだけ、端に留めるように少しずつ追従する
  useEffect(() => {
    if (!scrub.active) return;
    const s = editorStore.getState();
    const scale = makeScale(s.view.zoomPxPerSec, s.view.scrollMs);
    const x = xOf(scale, scrub.timeMs);
    const margin = size.w * SCRUB.scrollMarginRatio;
    if (x > size.w - margin) {
      editorStore.setView({ scrollMs: clampScroll(scrub.timeMs - (size.w - margin) / scale.pxPerMs, s.view.zoomPxPerSec, durationMs, size.w) });
    } else if (x < margin) {
      editorStore.setView({ scrollMs: clampScroll(scrub.timeMs - margin / scale.pxPerMs, s.view.zoomPxPerSec, durationMs, size.w) });
    }
  }, [scrub.active, scrub.timeMs, size.w, durationMs]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const getPos = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const scaleNow = () => {
    const v = editorStore.getState().view;
    return makeScale(v.zoomPxPerSec, v.scrollMs);
  };

  /** ドラッグプレビュー位置が共通検証を通るか（複数選択は最小間隔も拒否対象） */
  const previewPlacementOk = (level: LevelKey, ids: ReadonlySet<string>, deltaMs: number): boolean => {
    const docNow = editorStore.doc;
    const targets = docNow.levels[level].notes.filter((n) => ids.has(n.id));
    return checkPlacement(docNow, level, targets.map((n) => ({ id: n.id, hitAtMs: Math.round(n.hitAtMs + deltaMs) })), { rejectMinGap: targets.length > 1 }).ok;
  };

  const hitNote = (lane: Lane & { kind: 'level' }, x: number): string | null => {
    const scale = scaleNow();
    const notes = editorStore.doc.levels[lane.level].notes;
    const ms = msOf(scale, x);
    const tol = NOTE_HIT_PX / scale.pxPerMs;
    const times = notes.map((n) => n.hitAtMs);
    const [a, b] = visibleRange(times, ms - tol, ms + tol);
    let best: string | null = null;
    let bestD = Infinity;
    for (let i = a; i < b; i++) {
      const d = Math.abs(notes[i]!.hitAtMs - ms);
      if (d < bestD) {
        bestD = d;
        best = notes[i]!.id;
      }
    }
    if (best) return best;
    // 連打は区間（面）のどこをクリックしても選択できる
    for (const n of notes) {
      if (n.type === 'mash' && n.durationMs && ms >= n.hitAtMs - tol && ms <= n.hitAtMs + n.durationMs + tol) return n.id;
    }
    return null;
  };

  const hitChorus = (x: number): { id: string; edge: 'start' | 'end' | null } | null => {
    const scale = scaleNow();
    for (const c of editorStore.doc.choruses) {
      const x0 = xOf(scale, c.startMs);
      const x1 = xOf(scale, c.endMs);
      if (Math.abs(x - x0) <= EDGE_HIT_PX) return { id: c.id, edge: 'start' };
      if (Math.abs(x - x1) <= EDGE_HIT_PX) return { id: c.id, edge: 'end' };
      if (x > x0 && x < x1) return { id: c.id, edge: null };
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = getPos(e);
    const lane = laneAt(lanes, y);
    if (!lane) return;
    const scale = scaleNow();
    const ms = msOf(scale, x);
    canvasRef.current!.setPointerCapture(e.pointerId);
    canvasRef.current!.focus();
    if (lane.kind === 'ruler' || lane.kind === 'waveform') {
      if (e.shiftKey && lane.kind === 'ruler') {
        // Shift+ドラッグでループ範囲
        dragRef.current = { kind: 'chorus-new', startMs: -1 };
        editorStore.setLoop({ enabled: true, startMs: Math.round(ms), endMs: Math.round(ms) });
        (dragRef.current as { startMs: number }).startMs = -1 - Math.round(ms);
        return;
      }
      controller.seek(Math.max(0, Math.min(durationMs, ms)));
      dragRef.current = { kind: 'scrub' };
      return;
    }
    if (lane.kind === 'chorus') {
      const hit = hitChorus(x);
      if (hit) {
        const c = editorStore.doc.choruses.find((cc) => cc.id === hit.id)!;
        editorStore.setSelection({ kind: 'chorus', id: hit.id });
        dragRef.current = hit.edge
          ? { kind: 'chorus-resize', id: hit.id, edge: hit.edge, origStart: c.startMs, origEnd: c.endMs }
          : { kind: 'chorus-move', id: hit.id, startMs: ms, origStart: c.startMs, origEnd: c.endMs };
      } else {
        dragRef.current = { kind: 'chorus-new', startMs: snap(ms) };
        editorStore.setSelection(null);
      }
      return;
    }
    if (lane.kind === 'level') {
      editorStore.setView({ activeLevel: lane.level });
      const id = hitNote(lane, x);
      const sel = editorStore.getState().selection;
      if (id) {
        let ids: Set<string>;
        if (e.shiftKey && sel?.kind === 'notes' && sel.level === lane.level) {
          ids = new Set(sel.ids);
          if (ids.has(id)) ids.delete(id);
          else ids.add(id);
        } else if (sel?.kind === 'notes' && sel.level === lane.level && sel.ids.has(id)) {
          ids = new Set(sel.ids);
        } else ids = new Set([id]);
        editorStore.setSelection({ kind: 'notes', level: lane.level, ids });
        const note = editorStore.doc.levels[lane.level].notes.find((n) => n.id === id)!;
        dragRef.current = { kind: 'note-move', level: lane.level, ids, startMs: ms, anchorNoteMs: note.hitAtMs, moved: false };
      } else {
        if (!e.shiftKey) editorStore.setSelection(null);
        dragRef.current = { kind: 'marquee', x0: x, y0: y, additive: e.shiftKey };
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = getPos(e);
    const scale = scaleNow();
    const ms = msOf(scale, x);
    hoverRef.current = ms;
    const d = dragRef.current;
    const canvas = canvasRef.current!;
    if (d.kind === 'none') {
      const lane = laneAt(lanes, y);
      canvas.style.cursor = lane?.kind === 'chorus' ? (hitChorus(x)?.edge ? 'ew-resize' : hitChorus(x) ? 'grab' : 'crosshair') : lane?.kind === 'level' && hitNote(lane, x) ? 'grab' : 'default';
      return;
    }
    if (d.kind === 'scrub') {
      controller.seek(Math.max(0, Math.min(durationMs, ms)));
    } else if (d.kind === 'note-move') {
      const target = snap(d.anchorNoteMs + (ms - d.startMs));
      const delta = target - d.anchorNoteMs;
      d.moved = d.moved || Math.abs(x - xOf(scale, d.startMs)) > 2;
      const effective = d.moved ? delta : 0;
      // ドラッグ中も共通判定を通し、衝突する位置は警告色で表示する
      const conflict = effective !== 0 && !previewPlacementOk(d.level, d.ids, effective);
      editorStore.setDragPreview({ kind: 'notes', level: d.level, ids: d.ids, deltaMs: effective, conflict });
    } else if (d.kind === 'marquee') {
      editorStore.setDragPreview({ kind: 'marquee', x0: d.x0, y0: d.y0, x1: x, y1: y });
    } else if (d.kind === 'chorus-move') {
      const len = d.origEnd - d.origStart;
      let s = snap(d.origStart + (ms - d.startMs));
      s = Math.max(0, Math.min(durationMs - len, s));
      editorStore.setDragPreview({ kind: 'chorus', id: d.id, startMs: s, endMs: s + len });
    } else if (d.kind === 'chorus-resize') {
      const v = snap(ms);
      const s = d.edge === 'start' ? Math.max(0, Math.min(d.origEnd - 1, v)) : d.origStart;
      const en = d.edge === 'end' ? Math.min(durationMs, Math.max(d.origStart + 1, v)) : d.origEnd;
      editorStore.setDragPreview({ kind: 'chorus', id: d.id, startMs: s, endMs: en });
    } else if (d.kind === 'chorus-new') {
      if (d.startMs < 0) {
        const a = -1 - d.startMs;
        editorStore.setLoop({ enabled: true, startMs: Math.min(a, Math.round(ms)), endMs: Math.max(a, Math.round(ms)) });
      } else editorStore.setDragPreview({ kind: 'new-chorus', startMs: d.startMs, endMs: snap(ms) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const { x, y } = getPos(e);
    const d = dragRef.current;
    dragRef.current = { kind: 'none' };
    const preview = editorStore.getState().dragPreview;
    editorStore.setDragPreview(null);
    if (d.kind === 'note-move') {
      if (preview && preview.kind === 'notes' && preview.deltaMs !== 0) controller.dropNotes(d.level, d.ids, preview.deltaMs, grid);
    } else if (d.kind === 'marquee') {
      const x0 = Math.min(d.x0, x);
      const x1 = Math.max(d.x0, x);
      const y0 = Math.min(d.y0, y);
      const y1 = Math.max(d.y0, y);
      if (x1 - x0 < 3 && y1 - y0 < 3) return;
      const scale = scaleNow();
      const fromMs = msOf(scale, x0);
      const toMs = msOf(scale, x1);
      // マーキーが跨ぐレベルのうち、最初に当たったレベル（または編集中レベル）を対象にする
      const hitLanes = lanes.filter((l): l is Lane & { kind: 'level' } => l.kind === 'level' && l.y < y1 && l.y + l.h > y0);
      const active = editorStore.getState().view.activeLevel;
      const lane = hitLanes.find((l) => l.level === active) ?? hitLanes[0];
      if (!lane) return;
      const notes = editorStore.doc.levels[lane.level].notes;
      const [a, b] = visibleRange(
        notes.map((n) => n.hitAtMs),
        fromMs,
        toMs,
      );
      const prev = editorStore.getState().selection;
      const ids = new Set(d.additive && prev?.kind === 'notes' && prev.level === lane.level ? prev.ids : []);
      for (let i = a; i < b; i++) ids.add(notes[i]!.id);
      editorStore.setSelection(ids.size > 0 ? { kind: 'notes', level: lane.level, ids } : null);
      editorStore.setView({ activeLevel: lane.level });
    } else if (d.kind === 'chorus-move' || d.kind === 'chorus-resize') {
      if (preview && preview.kind === 'chorus' && (preview.startMs !== d.origStart || preview.endMs !== d.origEnd)) {
        editorStore.updateChorus(d.id, { startMs: preview.startMs, endMs: preview.endMs }, d.kind === 'chorus-move' ? 'サビ区間を移動' : 'サビ区間の長さを変更');
        controller.afterChorusEdit();
      }
    } else if (d.kind === 'chorus-new') {
      if (d.startMs < 0) {
        const loop = editorStore.getState().loop;
        if (loop.endMs - loop.startMs < 50) editorStore.setLoop({ enabled: false });
        else controller.syncLoop();
        return;
      }
      if (preview && preview.kind === 'new-chorus' && Math.abs(preview.endMs - preview.startMs) >= 200) {
        editorStore.addChorus(preview.startMs, preview.endMs);
        controller.afterChorusEdit();
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = getPos(e);
    const lane = laneAt(lanes, y);
    if (!lane || lane.kind !== 'level' || !doc.audio) return;
    if (hitNote(lane, x)) return;
    const raw = msOf(scaleNow(), x);
    controller.addNoteAt(lane.level, snap(raw), { rawMs: raw, grid });
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = editorStore.getState();
    if (e.metaKey || e.ctrlKey) {
      const { x } = getPos(e);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      editorStore.setView(zoomAround(s.view.zoomPxPerSec, s.view.scrollMs, x, factor, durationMs, size.w));
    } else {
      const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / (s.view.zoomPxPerSec / 1000);
      editorStore.setView({ scrollMs: clampScroll(s.view.scrollMs + delta, s.view.zoomPxPerSec, durationMs, size.w) });
    }
  };

  return (
    <div ref={wrapRef} className="timeline-wrap" data-testid="timeline" onWheel={onWheel}>
      <canvas
        ref={canvasRef}
        tabIndex={0}
        data-testid="timeline-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoverRef.current = null;
        }}
        onDoubleClick={onDoubleClick}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {focused && !playing && doc.audio && (
        <div className="scrub-hint" data-testid="scrub-hint" aria-hidden="true">
          ← → スクラブ / Shift: {SCRUB.stepShiftMs}ms / Option: {SCRUB.stepOptionMs}ms / 長押し: 連続スクラブ / J: ヒット追加 / F 長押し: 連打 / ⌘←→: ヒット移動
        </div>
      )}
    </div>
  );
}
