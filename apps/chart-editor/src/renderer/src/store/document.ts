import { generateLevelDetailed, type AnalysisResult, type LevelGenerationResult, type ManualNotePolicy } from '@autobeats/audio-analysis';
import {
  CROSS_LEVEL_EXCLUSION_MS,
  findNearestCrossLevelConflict,
  findCrossLevelConflicts,
  DEFAULT_LEVEL_SETTINGS,
  LEVEL_DISPLAY_NAMES,
  LEVEL_KEYS,
  LEVEL_PRIORITY,
  MASH,
  formatTimecode,
  noteEndMs,
  makeChorusId,
  makeNoteId,
  nextSeq,
  normalizeChoruses,
  sanitizeTrackId,
  type ChartNote,
  type ChorusSection,
  type CrossLevelConflictHit,
  type LevelGenerationSettings,
  type LevelKey,
  type LevelNumber,
  type LevelPairKey,
} from '@autobeats/chart-format';
import type { AudioMeta, EditorDocument } from '../../../shared/types';

export function levelNumber(key: LevelKey): LevelNumber {
  return Number(key) as LevelNumber;
}

export const EDITOR_LEVEL_KEYS = ['1', '2', '3'] as const;

export function createEmptyDocument(noteMode: EditorDocument['noteMode'] = 'additive'): EditorDocument {
  const levels = {} as EditorDocument['levels'];
  const levelSettings = {} as EditorDocument['levelSettings'];
  for (const k of LEVEL_KEYS) {
    levels[k] = { displayName: LEVEL_DISPLAY_NAMES[levelNumber(k)], notes: [] };
    levelSettings[k] = { ...DEFAULT_LEVEL_SETTINGS[levelNumber(k)], ...(noteMode === 'additive' && k === '1' ? { minGapMs: 300 } : {}), ...(noteMode === 'additive' && k === '2' ? { density: 0.65 } : {}), ...(noteMode === 'additive' && k === '3' ? { density: 0.9 } : {}) };
  }
  return { noteMode, title: '', artist: '', trackId: 'track', audio: null, analysis: null, bpm: 120, offsetMs: 0, choruses: [], levels, levelSettings };
}

export function documentWithAudio(doc: EditorDocument, audio: AudioMeta): EditorDocument {
  const base = doc.audio && doc.audio.sha256 !== audio.sha256 ? { ...createEmptyDocument(doc.noteMode ?? 'independent'), levelSettings: doc.levelSettings } : doc;
  const stem = audio.fileName.replace(/\.[^.]+$/, '');
  return {
    ...base,
    audio,
    title: base.title || stem,
    trackId: base.trackId === 'track' || !base.trackId ? sanitizeTrackId(stem, 'track') : base.trackId,
  };
}

export function sortNotes(notes: readonly ChartNote[]): ChartNote[] {
  return [...notes].sort((a, b) => a.hitAtMs - b.hitAtMs || a.id.localeCompare(b.id));
}

function durationOf(doc: EditorDocument): number {
  return doc.audio?.durationMs ?? 0;
}

function clampTime(doc: EditorDocument, ms: number): number {
  const max = Math.max(0, durationOf(doc) - 1);
  return Math.min(max, Math.max(0, Math.round(ms)));
}

function updateLevel(doc: EditorDocument, level: LevelKey, notes: ChartNote[]): EditorDocument {
  return { ...doc, levels: { ...doc.levels, [level]: { ...doc.levels[level], notes: sortNotes(notes) } } };
}

/** 編集結果。拒否された場合はドキュメントを変更せず理由を返す（Undo 履歴へ積まない） */
export type EditResult<T = unknown> = ({ ok: true; doc: EditorDocument; warnings: string[] } & T) | { ok: false; message: string; conflict?: CrossLevelConflictHit };

export interface Placement {
  /** 移動する既存ヒットの ID。新規追加なら undefined */
  id?: string;
  hitAtMs: number;
  /** 連打の長さ（通常ヒットは省略） */
  durationMs?: number;
}

export interface PlacementOptions {
  /** 同一レベル内の最小間隔違反を拒否する（複数選択移動）。false なら警告のみ */
  rejectMinGap?: boolean;
}

export type PlacementCheck = { ok: true; warnings: string[] } | { ok: false; message: string; conflict?: CrossLevelConflictHit };

/**
 * ヒット配置の共通検証。自動生成以外の全経路（追加・ドラッグ・数値入力・矢印移動・複数移動）がこれを通る。
 * - 整数、0ms 以上、曲の長さ未満
 * - 異なるレベル間の同時刻・近接・連打区間の重なりは許可する
 * - 同一レベル内で同時刻でない
 * - 同一レベルの最小間隔（警告または拒否）
 */
export function checkPlacement(doc: EditorDocument, level: LevelKey, placements: readonly Placement[], options: PlacementOptions = {}): PlacementCheck {
  const dur = durationOf(doc);
  const movingIds = new Set(placements.map((p) => p.id).filter((id): id is string => !!id));
  const warnings: string[] = [];
  const others = doc.levels[level].notes.filter((n) => !movingIds.has(n.id));
  const minGap = Math.max(doc.noteMode === 'additive' ? 81 : 1, doc.levelSettings[level].minGapMs);
  const seen = new Set<number>();
  for (const p of placements) {
    const t = p.hitAtMs;
    const dMs = p.durationMs ?? 0;
    const end = t + dMs;
    if (!Number.isInteger(t) || !Number.isInteger(dMs)) return { ok: false, message: `時刻 ${t} は整数ミリ秒ではありません。` };
    if (t < 0) return { ok: false, message: `時刻 ${t}ms は 0ms より前です。` };
    if (t >= dur) return { ok: false, message: `時刻 ${formatTimecode(t)} は曲の長さ（${formatTimecode(dur)}）以後です。` };
    if (dMs > 0 && dMs < MASH.minDurationMs) return { ok: false, message: `連打の長さは ${MASH.minDurationMs}ms 以上にしてください。` };
    if (end > dur) return { ok: false, message: `連打の終了（${formatTimecode(end)}）が曲の長さ（${formatTimecode(dur)}）を超えます。` };
    if (seen.has(t)) return { ok: false, message: `移動先 ${formatTimecode(t)} に複数のヒットが重なります。` };
    seen.add(t);
    if (doc.noteMode === 'additive') {
      const conflict = findNearestCrossLevelConflict(t, levelNumber(level), { ...doc.levels, '4': { notes: [] } }, CROSS_LEVEL_EXCLUSION_MS, movingIds, dMs);
      if (conflict) return { ok: false, conflict, message: `統合後の間隔を確保できません。Lv${conflict.level} の ${formatTimecode(conflict.hitAtMs)} から ${conflict.diffMs}ms です。追加分は既存の打点から80msより離してください。` };
    }
    for (const o of others) {
      const oEnd = noteEndMs(o);
      // 区間同士の距離（重なれば 0）
      const gap = oEnd < t ? t - oEnd : end < o.hitAtMs ? o.hitAtMs - end : 0;
      if (gap === 0) return { ok: false, message: `LEVEL ${level} の ${formatTimecode(o.hitAtMs)} のヒットと重なります。` };
      if (doc.noteMode === 'additive' && gap <= 80) return { ok: false, message: '統合後の打点間隔は80msより離してください。' };
      if (gap < minGap) {
        const msg = `LEVEL ${level} の ${formatTimecode(o.hitAtMs)} との間隔 ${gap}ms が最小間隔 ${minGap}ms を下回ります。`;
        if (options.rejectMinGap) return { ok: false, message: msg };
        warnings.push(msg);
      }
    }
  }
  if (doc.noteMode === 'additive') {
    const sorted = [...placements].sort((a, b) => a.hitAtMs - b.hitAtMs);
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.hitAtMs - (sorted[i - 1]!.hitAtMs + (sorted[i - 1]!.durationMs ?? 0)) <= 80) return { ok: false, message: '移動対象同士の打点間隔は80msより離してください。' };
  }
  // 移動対象同士の最小間隔
  const sortedT = [...seen].sort((a, b) => a - b);
  for (let i = 1; i < sortedT.length; i++) {
    const gap = sortedT[i]! - sortedT[i - 1]!;
    if (gap < minGap) {
      const msg = `移動対象同士の間隔 ${gap}ms が最小間隔 ${minGap}ms を下回ります。`;
      if (options.rejectMinGap) return { ok: false, message: msg };
      warnings.push(msg);
    }
  }
  return { ok: true, warnings };
}

export function addNote(doc: EditorDocument, level: LevelKey, hitAtMs: number): EditResult<{ id: string }> {
  const t = Math.round(hitAtMs);
  const check = checkPlacement(doc, level, [{ hitAtMs: t }]);
  if (!check.ok) return check;
  const notes = doc.levels[level].notes;
  const seq = nextSeq(notes.map((n) => n.id), `l${level}-note-`);
  const id = makeNoteId(levelNumber(level), seq);
  const note: ChartNote = { id, hitAtMs: t, source: 'manual', reason: 'manual', type: 'tap' };
  return { ok: true, doc: updateLevel(doc, level, [...notes, note]), id, warnings: check.warnings };
}

/** 連打（F 長押し）を追加する。長さは MASH.minDurationMs 以上 */
export function addMash(doc: EditorDocument, level: LevelKey, startMs: number, endMs: number): EditResult<{ id: string }> {
  const t = Math.round(Math.min(startMs, endMs));
  const durationMs = Math.round(Math.abs(endMs - startMs));
  if (durationMs < MASH.minDurationMs) return { ok: false, message: `連打は ${MASH.minDurationMs}ms 以上押し続けてください（${durationMs}ms）。` };
  const check = checkPlacement(doc, level, [{ hitAtMs: t, durationMs }]);
  if (!check.ok) return check;
  const notes = doc.levels[level].notes;
  const seq = nextSeq(notes.map((n) => n.id), `l${level}-note-`);
  const id = makeNoteId(levelNumber(level), seq);
  const note: ChartNote = { id, hitAtMs: t, source: 'manual', reason: 'manual', type: 'mash', durationMs };
  return { ok: true, doc: updateLevel(doc, level, [...notes, note]), id, warnings: check.warnings };
}

/** 連打の長さを変更する */
export function setNoteDuration(doc: EditorDocument, level: LevelKey, id: string, durationMs: number): EditResult {
  const note = doc.levels[level].notes.find((n) => n.id === id);
  if (!note) return { ok: false, message: 'ヒットが見つかりません。' };
  const d = Math.round(durationMs);
  const check = checkPlacement(doc, level, [{ id, hitAtMs: note.hitAtMs, durationMs: d }]);
  if (!check.ok) return check;
  const notes = doc.levels[level].notes.map((n) => (n.id === id ? { ...n, type: 'mash' as const, durationMs: d, source: 'manual' as const } : n));
  return { ok: true, doc: updateLevel(doc, level, notes), warnings: check.warnings };
}

/** 連打 ⇄ 通常ヒットの切り替え */
export function setNoteType(doc: EditorDocument, level: LevelKey, id: string, type: 'tap' | 'mash'): EditResult {
  const note = doc.levels[level].notes.find((n) => n.id === id);
  if (!note) return { ok: false, message: 'ヒットが見つかりません。' };
  if (type === 'mash') return setNoteDuration(doc, level, id, note.durationMs && note.durationMs >= MASH.minDurationMs ? note.durationMs : MASH.minDurationMs * 2);
  const notes = doc.levels[level].notes.map((n) => {
    if (n.id !== id) return n;
    const { durationMs: _d, ...rest } = n;
    return { ...rest, type: 'tap' as const, source: 'manual' as const };
  });
  return { ok: true, doc: updateLevel(doc, level, notes), warnings: [] };
}

export function moveNotes(doc: EditorDocument, level: LevelKey, ids: ReadonlySet<string>, deltaMs: number): EditResult {
  if (ids.size === 0 || deltaMs === 0) return { ok: true, doc, warnings: [] };
  const targets = doc.levels[level].notes.filter((n) => ids.has(n.id));
  const placements: Placement[] = targets.map((n) => ({ id: n.id, hitAtMs: Math.round(n.hitAtMs + deltaMs), ...(n.type === 'mash' && n.durationMs ? { durationMs: n.durationMs } : {}) }));
  const check = checkPlacement(doc, level, placements, { rejectMinGap: targets.length > 1 });
  if (!check.ok) return check;
  const notes = doc.levels[level].notes.map((n) => (ids.has(n.id) ? { ...n, hitAtMs: Math.round(n.hitAtMs + deltaMs), source: 'manual' as const } : n));
  return { ok: true, doc: updateLevel(doc, level, notes), warnings: check.warnings };
}

export function setNoteTime(doc: EditorDocument, level: LevelKey, id: string, hitAtMs: number): EditResult {
  const t = Math.round(hitAtMs);
  const note = doc.levels[level].notes.find((n) => n.id === id);
  const check = checkPlacement(doc, level, [{ id, hitAtMs: t, ...(note?.type === 'mash' && note.durationMs ? { durationMs: note.durationMs } : {}) }]);
  if (!check.ok) return check;
  const notes = doc.levels[level].notes.map((n) => (n.id === id ? { ...n, hitAtMs: t, source: 'manual' as const } : n));
  return { ok: true, doc: updateLevel(doc, level, notes), warnings: check.warnings };
}

export function deleteNotes(doc: EditorDocument, level: LevelKey, ids: ReadonlySet<string>): EditorDocument {
  return updateLevel(
    doc,
    level,
    doc.levels[level].notes.filter((n) => !ids.has(n.id)),
  );
}

export function addChorus(doc: EditorDocument, startMs: number, endMs: number): { doc: EditorDocument; id: string } {
  const s = clampTime(doc, Math.min(startMs, endMs));
  const e = Math.min(durationOf(doc), Math.max(s + 1, Math.round(Math.max(startMs, endMs))));
  const seq = nextSeq(doc.choruses.map((c) => c.id), 'chorus-');
  const id = makeChorusId(seq);
  const chorus: ChorusSection = { id, startMs: s, endMs: e, confidence: 1, source: 'manual' };
  return { doc: { ...doc, choruses: [...doc.choruses, chorus].sort((a, b) => a.startMs - b.startMs) }, id };
}

export function updateChorus(doc: EditorDocument, id: string, patch: { startMs?: number; endMs?: number }): EditorDocument {
  const dur = durationOf(doc);
  const choruses = doc.choruses.map((c) => {
    if (c.id !== id) return c;
    let s = patch.startMs !== undefined ? Math.round(patch.startMs) : c.startMs;
    let e = patch.endMs !== undefined ? Math.round(patch.endMs) : c.endMs;
    s = Math.max(0, Math.min(dur - 1, s));
    e = Math.max(s + 1, Math.min(dur, e));
    return { ...c, startMs: s, endMs: e, source: 'manual' as const };
  });
  return { ...doc, choruses: choruses.sort((a, b) => a.startMs - b.startMs) };
}

export function moveChorus(doc: EditorDocument, id: string, deltaMs: number): EditorDocument {
  const c = doc.choruses.find((x) => x.id === id);
  if (!c) return doc;
  const dur = durationOf(doc);
  const len = c.endMs - c.startMs;
  const s = Math.max(0, Math.min(dur - len, c.startMs + deltaMs));
  return updateChorus(doc, id, { startMs: s, endMs: s + len });
}

export function deleteChorus(doc: EditorDocument, id: string): EditorDocument {
  return { ...doc, choruses: doc.choruses.filter((c) => c.id !== id) };
}

export function mergeOverlappingChoruses(doc: EditorDocument): EditorDocument {
  return { ...doc, choruses: normalizeChoruses(doc.choruses, durationOf(doc)) };
}

export function setLevelSettings(doc: EditorDocument, level: LevelKey, patch: Partial<LevelGenerationSettings>): EditorDocument {
  return { ...doc, levelSettings: { ...doc.levelSettings, [level]: { ...doc.levelSettings[level], ...patch } } };
}

/** 解析結果を適用する。choruses は置換（既存 manual は keepManualChoruses なら残す） */
export function applyAnalysis(doc: EditorDocument, analysis: AnalysisResult, keepManualChoruses = true): EditorDocument {
  const manual = keepManualChoruses ? doc.choruses.filter((c) => c.source === 'manual') : [];
  const detected = analysis.choruses.map((c, i) => ({ ...c, id: `chorus-${i + 1}` }));
  const seqStart = detected.length + 1;
  const manualRenumbered = manual.map((c, i) => ({ ...c, id: makeChorusId(seqStart + i) }));
  const choruses = normalizeChoruses([...detected, ...manualRenumbered], analysis.durationMs);
  return { ...doc, analysis, bpm: analysis.bpm, offsetMs: analysis.offsetMs, choruses };
}

export interface RegenerateOutcome {
  doc: EditorDocument;
  reports: LevelGenerationResult[];
  /** 目標数に達しなかったレベルの日本語警告 */
  shortfalls: string[];
}

/**
 * 指定レベルを LEVEL 1→4 の優先順で再生成する。
 * 各レベルを独立して生成し、保持する同一レベルの手作業ヒットだけを避ける。
 * 1操作としてコミットできるよう新しいドキュメントを返す。
 */
export function regenerateLevels(doc: EditorDocument, levels: readonly LevelKey[], manualPolicy: ManualNotePolicy): RegenerateOutcome {
  if (!doc.analysis) return { doc, reports: [], shortfalls: [] };
  if (doc.noteMode === 'additive') return regenerateAdditions(doc, levels, manualPolicy);
  const durationMs = durationOf(doc) || doc.analysis.durationMs;
  const existing = {} as Record<LevelNumber, readonly ChartNote[]>;
  const settings = {} as Record<LevelNumber, LevelGenerationSettings>;
  for (const k of LEVEL_KEYS) {
    existing[levelNumber(k)] = doc.levels[k].notes;
    settings[levelNumber(k)] = doc.levelSettings[k];
  }
  // 各難易度を独立して生成する。他レベルのノーツは除外条件にしない。
  const detailed: Partial<Record<LevelNumber, LevelGenerationResult>> = {};
  for (const key of levels) {
    const level = levelNumber(key);
    detailed[level] = generateLevelDetailed(level, { analysis: doc.analysis, choruses: doc.choruses, durationMs, settings, existing, manualPolicy });
  }
  let next = doc;
  const reports: LevelGenerationResult[] = [];
  const shortfalls: string[] = [];
  for (const l of LEVEL_PRIORITY) {
    const r = detailed[l];
    if (!r) continue;
    next = updateLevel(next, String(l) as LevelKey, r.notes);
    reports.push(r);
    if (r.generatedCount < r.targetCount) {
      shortfalls.push(`LEVEL ${l}は、目標ヒット数に達しませんでした。\n生成数: ${r.generatedCount} / 目標: ${r.targetCount}`);
    }
  }
  return { doc: next, reports, shortfalls };
}

/** Lv1は変更せず、Lv2→Lv3の追加分だけを生成する。 */
function regenerateAdditions(doc: EditorDocument, requested: readonly LevelKey[], manualPolicy: ManualNotePolicy): RegenerateOutcome {
  const sourceAnalysis = doc.analysis;
  if (!sourceAnalysis) return { doc, reports: [], shortfalls: [] };
  if (doc.levels['1'].notes.length === 0) {
    const usedTimes = EDITOR_LEVEL_KEYS.filter((k) => k !== '1').flatMap((k) => doc.levels[k].notes.map((n) => ({ level: levelNumber(k), hitAtMs: n.hitAtMs, id: n.id, durationMs: n.type === 'mash' ? n.durationMs : undefined })));
    const base = generateLevelDetailed(1, { analysis: sourceAnalysis, choruses: doc.choruses, durationMs: durationOf(doc), musicalPhrasing: true, settings: { 1: { ...doc.levelSettings['1'], minGapMs: Math.max(81, doc.levelSettings['1'].minGapMs) } }, usedTimes, crossLevelExclusionMs: CROSS_LEVEL_EXCLUSION_MS });
    doc = updateLevel(doc, '1', base.notes);
    if (base.notes.length === 0) return { doc, reports: [base], shortfalls: ['Lv1の生成候補がありません。音源や解析結果を確認してください。'] };
  }
  const targets = EDITOR_LEVEL_KEYS.filter((k) => k !== '1' && requested.includes(k));
  let next = doc;
  for (const k of targets) next = updateLevel(next, k, manualPolicy === 'keep' ? next.levels[k].notes.filter((n) => n.source === 'manual') : []);
  const reports: LevelGenerationResult[] = [];
  const shortfalls: string[] = [];
  for (const key of targets) {
    const level = levelNumber(key);
    const lower = EDITOR_LEVEL_KEYS.filter((k) => Number(k) < level).flatMap((k) => next.levels[k].notes);
    const usedTimes = EDITOR_LEVEL_KEYS.filter((k) => k !== key).flatMap((k) => next.levels[k].notes.map((n) => ({ level: levelNumber(k), hitAtMs: n.hitAtMs, id: n.id, durationMs: n.type === 'mash' ? n.durationMs : undefined })));
    const lowerTimes = lower.map((n) => n.hitAtMs).sort((a, b) => a - b);
    // 下位譜面のフレーズ内を対象とし、空のイントロ・アウトロを勝手に埋めない。
    const first = lowerTimes[0]!;
    const last = Math.max(...lower.map(noteEndMs));
    const analysis = { ...sourceAnalysis, leadInEndMs: Math.max(sourceAnalysis.leadInEndMs, first), tailStartMs: Math.min(sourceAnalysis.tailStartMs, last + 1) };
    const r = generateLevelDetailed(level, { analysis, cumulativeBase: lower, musicalPhrasing: true, choruses: doc.choruses, durationMs: durationOf(doc), settings: { [level]: { ...doc.levelSettings[key], minGapMs: Math.max(81, doc.levelSettings[key].minGapMs) } }, existing: { [level]: next.levels[key].notes }, manualPolicy: 'keep', usedTimes, crossLevelExclusionMs: CROSS_LEVEL_EXCLUSION_MS });
    next = updateLevel(next, key, r.notes);
    reports.push(r);
    if (r.generatedCount === 0) shortfalls.push(`Lv${key}の追加候補はありません。下位譜面の間隔や密度設定を確認してください。`);
  }
  return { doc: next, reports, shortfalls };
}

export interface RepairOutcome {
  doc: EditorDocument;
  moved: number;
  deleted: number;
  unresolved: number;
}

/** 旧プロジェクトとの互換用。難易度間の重なりは許可するため変更しない。 */
export function repairCrossLevelConflicts(doc: EditorDocument): RepairOutcome {
  return { doc, moved: 0, deleted: 0, unresolved: 0 };
}

export type NoteIssueCode = 'collision' | 'min-gap' | 'range' | 'cross-level' | 'bad-id' | 'non-integer';

export interface NoteIssue {
  level: LevelKey;
  id: string;
  hitAtMs: number;
  code: NoteIssueCode;
  message: string;
  /** cross-level のときの相手 */
  other?: { level: LevelKey; id: string; hitAtMs: number };
  pairKey?: LevelPairKey;
}

export interface IssueSummary {
  total: number;
  byCode: Record<NoteIssueCode, number>;
  crossLevelByPair: Record<LevelPairKey, number>;
  /** 書き出しを禁止すべき問題があるか（min-gap も含む） */
  hasErrors: boolean;
}

/** リアルタイム表示・書き出し前検証用の違反検出（同一レベル内と難易度間を分けて数える） */
export function findNoteIssues(doc: EditorDocument): NoteIssue[] {
  const issues: NoteIssue[] = [];
  const dur = durationOf(doc);
  for (const k of LEVEL_KEYS) {
    const notes = sortNotes(doc.levels[k].notes);
    const minGap = Math.max(doc.noteMode === 'additive' ? 81 : 1, doc.levelSettings[k].minGapMs);
    const ids = new Set<string>();
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]!;
      if (!n.id || ids.has(n.id)) issues.push({ level: k, id: n.id, hitAtMs: n.hitAtMs, code: 'bad-id', message: `L${k} ${formatTimecode(n.hitAtMs)} の ID "${n.id}" が空または重複しています` });
      ids.add(n.id);
      if (!Number.isInteger(n.hitAtMs)) issues.push({ level: k, id: n.id, hitAtMs: n.hitAtMs, code: 'non-integer', message: `L${k} の hitAtMs ${n.hitAtMs} が整数ではありません` });
      if (n.hitAtMs < 0 || n.hitAtMs >= dur) issues.push({ level: k, id: n.id, hitAtMs: n.hitAtMs, code: 'range', message: `L${k} ${n.hitAtMs}ms は曲の範囲外です` });
      if (n.type === 'mash' && (!n.durationMs || n.durationMs < MASH.minDurationMs)) issues.push({ level: k, id: n.id, hitAtMs: n.hitAtMs, code: 'range', message: `L${k} ${formatTimecode(n.hitAtMs)} の連打の長さが ${MASH.minDurationMs}ms 未満です` });
      if (n.type === 'mash' && noteEndMs(n) > dur) issues.push({ level: k, id: n.id, hitAtMs: n.hitAtMs, code: 'range', message: `L${k} ${formatTimecode(n.hitAtMs)} の連打の終了が曲の範囲外です` });
      if (i > 0) {
        const prev = notes[i - 1]!;
        const gap = n.hitAtMs - noteEndMs(prev);
        if (gap <= 0) issues.push({ level: k, id: n.id, hitAtMs: n.hitAtMs, code: 'collision', message: prev.type === 'mash' ? `L${k} ${formatTimecode(n.hitAtMs)} が連打 ${formatTimecode(prev.hitAtMs)}〜${formatTimecode(noteEndMs(prev))} と重なっています` : `L${k} ${formatTimecode(n.hitAtMs)} にヒットが重複しています` });
        else if (gap < minGap) issues.push({ level: k, id: n.id, hitAtMs: n.hitAtMs, code: 'min-gap', message: `L${k} ${formatTimecode(noteEndMs(prev))}→${formatTimecode(n.hitAtMs)} の間隔 ${gap}ms が最小間隔 ${minGap}ms 未満です` });
      }
    }
  }
  if (doc.noteMode === 'additive') {
    const report = findCrossLevelConflicts({ ...doc.levels, '4': { notes: [] } }, CROSS_LEVEL_EXCLUSION_MS);
    for (const p of report.pairs) issues.push({ level: String(p.levelB) as LevelKey, id: p.noteB.id, hitAtMs: p.noteB.hitAtMs, code: 'cross-level', pairKey: `${p.levelA}-${p.levelB}`, message: `統合後の間隔不足: Lv${p.levelA} と Lv${p.levelB} の打点間隔が ${p.diffMs}ms（80ms以内）です。` });
  }
  return issues;
}

export function summarizeIssues(issues: readonly NoteIssue[]): IssueSummary {
  const byCode: Record<NoteIssueCode, number> = { collision: 0, 'min-gap': 0, range: 0, 'cross-level': 0, 'bad-id': 0, 'non-integer': 0 };
  const crossLevelByPair: Record<LevelPairKey, number> = { '1-2': 0, '1-3': 0, '1-4': 0, '2-3': 0, '2-4': 0, '3-4': 0 } as Record<LevelPairKey, number>;
  for (const i of issues) {
    byCode[i.code]++;
    if (i.code === 'cross-level' && i.pairKey) crossLevelByPair[i.pairKey] = (crossLevelByPair[i.pairKey] ?? 0) + 1;
  }
  return { total: issues.length, byCode, crossLevelByPair, hasErrors: issues.length > 0 };
}

/** 難易度間衝突の有無（読込時の検出に使う） */
export function hasCrossLevelConflicts(_doc: EditorDocument): boolean {
  return false;
}
