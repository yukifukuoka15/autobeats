import { pickPeakLevel, type WaveformPeaks } from '@autobeats/audio-analysis';
import { LEVEL_KEYS, formatTimecode, noteEndMs, type ChartNote, type ChorusSection, type LevelKey } from '@autobeats/chart-format';
import type { EditorDocument } from '../../../shared/types';
import type { EditorState } from '../store/editorStore';
import { msOf, pickTickStepMs, visibleRange, xOf, type Lane, type TimeScale } from './geometry';

/** レベル色（メインアプリのキャラクター配色: 黄・水色・桃・橙） */
export const LEVEL_COLORS: Record<LevelKey, string> = { '1': '#ffff00', '2': '#00ffff', '3': '#ffb8ff', '4': '#ffb852' };
/** タイムラインの配色（黒地・赤い壁・黄色い再生ヘッド） */
export const COLORS = {
  bg: '#000000',
  laneBg: '#0c0303',
  laneAlt: '#080202',
  grid: '#3a1010',
  gridStrong: '#661a1a',
  text: '#e8e8ea',
  textDim: '#a3a3b8',
  wave: '#ff5a5a',
  waveFill: 'rgba(222,33,33,0.55)',
  playhead: '#ffff00',
  chorus: 'rgba(255,184,255,0.28)',
  chorusStrong: 'rgba(255,184,255,0.8)',
  chorusFaint: 'rgba(255,184,255,0.07)',
  chorusDetected: 'rgba(255,184,82,0.8)',
  selection: '#ffffff',
  loop: 'rgba(255,255,0,0.12)',
  issue: '#ff2a2a',
};

export interface DrawInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  lanes: Lane[];
  scale: TimeScale;
  doc: EditorDocument;
  state: EditorState;
  peaks: WaveformPeaks | null;
  playheadMs: number;
  issueIds: ReadonlySet<string>;
  hoverMs: number | null;
  reducedMotion: boolean;
}

export function drawTimeline(input: DrawInput): void {
  const { ctx, width, height, dpr, lanes, scale, doc, state, playheadMs } = input;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);
  const durationMs = doc.audio?.durationMs ?? 0;
  const fromMs = msOf(scale, 0);
  const toMs = msOf(scale, width);

  // レーン背景
  for (const lane of lanes) {
    ctx.fillStyle = lane.kind === 'level' && Number(lane.level) % 2 === 0 ? COLORS.laneAlt : COLORS.laneBg;
    if (lane.kind === 'ruler' || lane.kind === 'chorus') ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, lane.y, width, lane.h);
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(0, lane.y + lane.h - 1, width, 1);
  }
  // 曲の終端以降を暗くする
  if (durationMs > 0) {
    const endX = xOf(scale, durationMs);
    if (endX < width) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(Math.max(0, endX), 0, width - Math.max(0, endX), height);
    }
  }

  drawGrid(input, fromMs, toMs);
  drawChoruses(input, fromMs, toMs);
  drawWaveform(input);
  drawLoop(input);
  drawNotes(input, fromMs, toMs);
  drawMashPreview(input);
  drawRulerLabels(input, fromMs, toMs);

  // 再生ヘッド
  const px = xOf(scale, playheadMs);
  if (px >= -2 && px <= width + 2) {
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px + 0.5, 0);
    ctx.lineTo(px + 0.5, height);
    ctx.stroke();
    ctx.fillStyle = COLORS.playhead;
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px, 9);
    ctx.closePath();
    ctx.fill();
  }

  // マーキー
  const dp = state.dragPreview;
  if (dp && dp.kind === 'marquee') {
    ctx.strokeStyle = 'rgba(57,229,255,0.9)';
    ctx.fillStyle = 'rgba(57,229,255,0.12)';
    ctx.setLineDash([4, 3]);
    const x = Math.min(dp.x0, dp.x1);
    const y = Math.min(dp.y0, dp.y1);
    ctx.fillRect(x, y, Math.abs(dp.x1 - dp.x0), Math.abs(dp.y1 - dp.y0));
    ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(dp.x1 - dp.x0), Math.abs(dp.y1 - dp.y0));
    ctx.setLineDash([]);
  }
  // ホバー位置
  if (input.hoverMs !== null) {
    const hx = xOf(scale, input.hoverMs);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, 0);
    ctx.lineTo(hx + 0.5, height);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGrid(input: DrawInput, fromMs: number, toMs: number): void {
  const { ctx, height, scale, doc, lanes } = input;
  const ruler = lanes[0]!;
  const beats = doc.analysis?.beats ?? [];
  const downbeats = new Set(doc.analysis?.downbeats ?? []);
  const pxPerBeat = beats.length > 1 ? (beats[1]! - beats[0]!) * scale.pxPerMs : 0;
  if (beats.length > 1 && pxPerBeat >= 5) {
    const [a, b] = visibleRange(beats, fromMs, toMs);
    let bar = 0;
    for (let i = 0; i < a; i++) if (downbeats.has(beats[i]!)) bar++;
    for (let i = a; i < b; i++) {
      const t = beats[i]!;
      const x = Math.round(xOf(scale, t)) + 0.5;
      const isDown = downbeats.has(t);
      if (isDown) bar++;
      ctx.strokeStyle = isDown ? COLORS.gridStrong : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, ruler.h);
      ctx.lineTo(x, height);
      ctx.stroke();
      if (isDown && pxPerBeat * 4 >= 40) {
        ctx.fillStyle = COLORS.textDim;
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${bar}`, x + 3, ruler.y + ruler.h - 3);
      }
    }
  }
}

/** F 長押し中の連打プレビュー（開始から再生ヘッドまで） */
function drawMashPreview(input: DrawInput): void {
  const mp = input.state.mashPreview;
  if (!mp) return;
  const lane = input.lanes.find((l): l is Lane & { kind: 'level' } => l.kind === 'level' && l.level === mp.level);
  if (!lane) return;
  drawMashCapsule(input.ctx, xOf(input.scale, mp.startMs), xOf(input.scale, Math.max(mp.startMs, input.playheadMs)), lane.y, lane.h, COLORS.selection, true);
}

function drawRulerLabels(input: DrawInput, fromMs: number, toMs: number): void {
  const { ctx, scale, lanes } = input;
  const ruler = lanes[0]!;
  const { major, minor } = pickTickStepMs(scale.pxPerMs);
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  const start = Math.floor(fromMs / minor) * minor;
  for (let t = Math.max(0, start); t <= toMs; t += minor) {
    const x = Math.round(xOf(scale, t)) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ctx.strokeStyle = isMajor ? COLORS.text : COLORS.textDim;
    ctx.beginPath();
    ctx.moveTo(x, ruler.y + (isMajor ? 0 : ruler.h * 0.55));
    ctx.lineTo(x, ruler.y + ruler.h * 0.75);
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = COLORS.text;
      ctx.fillText(formatTimecode(t, major < 1000), x + 3, ruler.y + 10);
    }
  }
}

function drawChoruses(input: DrawInput, fromMs: number, toMs: number): void {
  const { ctx, width, height, scale, doc, state, lanes } = input;
  const strip = lanes[1]!;
  const wave = lanes[2]!;
  const dp = state.dragPreview;
  const list: (ChorusSection & { preview?: boolean })[] = doc.choruses.map((c) => (dp && dp.kind === 'chorus' && dp.id === c.id ? { ...c, startMs: dp.startMs, endMs: dp.endMs, preview: true } : c));
  if (dp && dp.kind === 'new-chorus') list.push({ id: '__new', startMs: Math.min(dp.startMs, dp.endMs), endMs: Math.max(dp.startMs, dp.endMs), confidence: 1, source: 'manual', preview: true });
  for (const c of list) {
    if (c.endMs < fromMs || c.startMs > toMs) continue;
    const x0 = Math.max(-1, xOf(scale, c.startMs));
    const x1 = Math.min(width + 1, xOf(scale, c.endMs));
    const w = Math.max(1, x1 - x0);
    const selected = state.selection?.kind === 'chorus' && state.selection.id === c.id;
    // 全レーンへ薄く延長
    ctx.fillStyle = COLORS.chorusFaint;
    ctx.fillRect(x0, wave.y + wave.h, w, height - wave.y - wave.h);
    // 波形上
    ctx.fillStyle = COLORS.chorus;
    ctx.fillRect(x0, wave.y, w, wave.h);
    // ストリップ
    ctx.fillStyle = c.source === 'detected' ? COLORS.chorusDetected : COLORS.chorusStrong;
    ctx.fillRect(x0, strip.y + 3, w, strip.h - 6);
    if (selected || c.preview) {
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.5, strip.y + 2.5, w - 1, strip.h - 5);
    }
    // 端のハンドル
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x0, strip.y + 2, 2, strip.h - 4);
    ctx.fillRect(x1 - 2, strip.y + 2, 2, strip.h - 4);
    if (w > 60) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px -apple-system, "Hiragino Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`サビ ${c.source === 'detected' ? `${Math.round(c.confidence * 100)}%` : '手動'}`, x0 + 6, strip.y + strip.h - 5);
    }
  }
}

function drawWaveform(input: DrawInput): void {
  const { ctx, width, scale, peaks, lanes } = input;
  const wave = lanes[2]!;
  const mid = wave.y + wave.h / 2;
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(width, mid + 0.5);
  ctx.stroke();
  if (!peaks) {
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '12px -apple-system, "Hiragino Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('楽曲を読み込むと波形が表示されます', 12, mid + 4);
    return;
  }
  const samplesPerPx = peaks.sampleRate / 1000 / scale.pxPerMs;
  const level = pickPeakLevel(peaks, samplesPerPx);
  const binsPerPx = samplesPerPx / level.samplesPerBin;
  const amp = (wave.h / 2) * 0.92;
  ctx.fillStyle = COLORS.waveFill;
  ctx.strokeStyle = COLORS.wave;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const startBin = (scale.scrollMs / 1000) * peaks.sampleRate / level.samplesPerBin;
  for (let px = 0; px < width; px++) {
    const b0 = Math.floor(startBin + px * binsPerPx);
    const b1 = Math.max(b0 + 1, Math.floor(startBin + (px + 1) * binsPerPx));
    if (b0 < 0 || b0 >= level.min.length) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (let b = b0; b < Math.min(b1, level.min.length); b++) {
      if (level.min[b]! < lo) lo = level.min[b]!;
      if (level.max[b]! > hi) hi = level.max[b]!;
    }
    if (lo === Infinity) continue;
    const y0 = mid - hi * amp;
    const y1 = mid - lo * amp;
    ctx.fillRect(px, y0, 1, Math.max(1, y1 - y0));
  }
}

function drawLoop(input: DrawInput): void {
  const { ctx, scale, state, lanes } = input;
  if (!state.loop.enabled) return;
  const ruler = lanes[0]!;
  const x0 = xOf(scale, state.loop.startMs);
  const x1 = xOf(scale, state.loop.endMs);
  ctx.fillStyle = COLORS.loop;
  ctx.fillRect(x0, ruler.y, x1 - x0, input.height);
  ctx.strokeStyle = COLORS.playhead;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x0 + 0.5, 0);
  ctx.lineTo(x0 + 0.5, input.height);
  ctx.moveTo(x1 + 0.5, 0);
  ctx.lineTo(x1 + 0.5, input.height);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawNotes(input: DrawInput, fromMs: number, toMs: number): void {
  const { ctx, scale, doc, state, lanes, issueIds } = input;
  const dp = state.dragPreview;
  for (const lane of lanes) {
    if (lane.kind !== 'level') continue;
    const level = lane.level;
    const color = LEVEL_COLORS[level];
    const notes = doc.levels[level].notes;
    const sel = state.selection?.kind === 'notes' && state.selection.level === level ? state.selection.ids : null;
    const dragIds = dp && dp.kind === 'notes' && dp.level === level ? dp.ids : null;
    const dragDelta = dp && dp.kind === 'notes' ? dp.deltaMs : 0;
    const dragConflict = dp && dp.kind === 'notes' ? dp.conflict : false;
    const margin = Math.abs(dragDelta) + 10 / scale.pxPerMs;
    const times = notes.map((n) => n.hitAtMs);
    const [a, b] = visibleRange(times, fromMs - margin, toMs + margin);
    const isActive = state.view.activeLevel === level;
    // 下位レベルは参考表示のみ。選択・保存対象には含めない。
    if (doc.noteMode === 'additive') {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      for (const lower of ['1', '2'] as const) {
        if (Number(lower) >= Number(level)) continue;
        for (const n of doc.levels[lower].notes) {
          if (noteEndMs(n) < fromMs || n.hitAtMs > toMs) continue;
          const x = xOf(scale, n.hitAtMs);
          ctx.beginPath(); ctx.moveTo(x, lane.y + 20); ctx.lineTo(x, lane.y + lane.h - 6); ctx.stroke();
          if (n.type === 'mash' && n.durationMs) ctx.strokeRect(x, lane.y + 28, xOf(scale, noteEndMs(n)) - x, 8);
        }
      }
      ctx.restore();
    }
    // ラベル
    ctx.fillStyle = isActive ? color : 'rgba(255,255,255,0.4)';
    ctx.font = 'bold 11px -apple-system, "Hiragino Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`L${level}`, 6, lane.y + 13);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px -apple-system, "Hiragino Sans", sans-serif';
    ctx.fillText(`${doc.levels[level].displayName}  ${notes.length}${doc.noteMode === 'additive' && level !== '1' ? '追加打点' : 'ヒット'}`, 28, lane.y + 13);
    if (isActive) {
      ctx.fillStyle = color;
      ctx.fillRect(0, lane.y, 3, lane.h);
    }
    // 連打は区間を持つので、表示範囲の左側にある開始点も走査する（最大区間長ぶん広げる）
    const maxSpan = notes.reduce((m, n) => Math.max(m, noteEndMs(n) - n.hitAtMs), 0);
    const [a0] = visibleRange(times, fromMs - margin - maxSpan, toMs + margin);
    for (let i = Math.min(a, a0); i < b; i++) {
      const n: ChartNote = notes[i]!;
      const t = dragIds && dragIds.has(n.id) ? n.hitAtMs + dragDelta : n.hitAtMs;
      const x = Math.round(xOf(scale, t)) + 0.5;
      const selected = sel?.has(n.id) ?? false;
      const dragging = dragIds !== null && dragIds.has(n.id);
      const issue = issueIds.has(`${level}:${n.id}`) || (dragging && dragConflict);
      if (n.type === 'mash' && n.durationMs) {
        drawMashCapsule(ctx, x, xOf(scale, t + n.durationMs), lane.y, lane.h, issue ? COLORS.issue : color, selected);
        continue;
      }
      if (i < a) continue;
      ctx.strokeStyle = issue ? COLORS.issue : selected ? COLORS.selection : color;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, lane.y + 4);
      ctx.lineTo(x, lane.y + lane.h - 4);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      if (n.source === 'manual') {
        ctx.moveTo(x - 5, lane.y + lane.h - 3);
        ctx.lineTo(x + 5, lane.y + lane.h - 3);
        ctx.lineTo(x, lane.y + lane.h - 10);
      } else {
        ctx.moveTo(x - 5, lane.y + 3);
        ctx.lineTo(x + 5, lane.y + 3);
        ctx.lineTo(x, lane.y + 10);
      }
      ctx.closePath();
      ctx.fill();
      if (selected) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x - 4, lane.y + 2, 8, lane.h - 4);
      }
    }
  }
}

/**
 * 連打の面表示: 両端が半円、中間が長方形のカプセル。
 * 開始 x0 から終了 x1 まで、レーン高さの中央に描く。
 */
export function drawMashCapsule(ctx: CanvasRenderingContext2D, x0: number, x1: number, laneY: number, laneH: number, color: string, selected: boolean): void {
  const h = Math.max(10, laneH - 24);
  const r = h / 2;
  const cy = laneY + laneH / 2;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  ctx.beginPath();
  if (right - left <= 2 * r) {
    ctx.arc((left + right) / 2, cy, r, 0, Math.PI * 2);
  } else {
    ctx.arc(left + r, cy, r, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.lineTo(right - r, cy - r);
    ctx.arc(right - r, cy, r, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.globalAlpha = selected ? 0.55 : 0.35;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.strokeStyle = selected ? COLORS.selection : color;
  ctx.stroke();
  // 開始位置の縦線（タイミングの基準）
  ctx.lineWidth = 1;
  ctx.strokeStyle = selected ? COLORS.selection : color;
  ctx.beginPath();
  ctx.moveTo(Math.round(left) + 0.5, laneY + 4);
  ctx.lineTo(Math.round(left) + 0.5, laneY + laneH - 4);
  ctx.stroke();
}

export { LEVEL_KEYS };
