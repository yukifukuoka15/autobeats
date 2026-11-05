import {
  CROSS_LEVEL_EXCLUSION_MS,
  DEFAULT_LEVEL_SETTINGS,
  LEVEL_NUMBERS,
  LEVEL_PRIORITY,
  conflictsWithOtherLevel,
  isInChorus,
  makeNoteId,
  nextSeq,
  type ChartNote,
  type ChorusSection,
  type LevelGenerationSettings,
  type LevelNumber,
  type NoteReason,
  type UsedNoteTime,
} from '@autobeats/chart-format';
import type { AnalysisResult } from './types';

export type GenerationAnalysis = Pick<AnalysisResult, 'beats' | 'downbeats' | 'onsets' | 'leadInEndMs' | 'tailStartMs' | 'bpm' | 'beatsPerBar'>;

export type ManualNotePolicy = 'keep' | 'replace';

export interface GenerationInput {
  analysis: GenerationAnalysis;
  choruses: readonly ChorusSection[];
  durationMs: number;
  settings?: Partial<Record<LevelNumber, LevelGenerationSettings>>;
  /** 既存の音符（手作業音符の保持判定に使う） */
  existing?: Partial<Record<LevelNumber, readonly ChartNote[]>>;
  manualPolicy?: ManualNotePolicy;
  /**
   * 他レベルの確定音符。これらから crossLevelExclusionMs 以内の候補は採用しない。
   * generateAllLevels は LEVEL_PRIORITY 順に生成しながら自動で積み上げる。
   */
  usedTimes?: readonly UsedNoteTime[];
  /** 難易度間除外幅（ms）。既定は CROSS_LEVEL_EXCLUSION_MS */
  crossLevelExclusionMs?: number;
}

export interface LevelGenerationResult {
  level: LevelNumber;
  notes: ChartNote[];
  /** 難易度間除外がなければ採用できた音符数（目標） */
  targetCount: number;
  /** 実際に自動生成した音符数（手作業音符を含まない） */
  generatedCount: number;
  /** 他レベルとの重複で採用を見送った候補数 */
  excludedByCrossLevel: number;
}

interface Candidate {
  timeMs: number;
  reason: NoteReason;
  base: number;
  onsetStrength: number;
  score: number;
}

interface LevelProfile {
  /** 通常区間で採用してよい候補種別 */
  reasons: ReadonlySet<NoteReason>;
  /** サビ区間で追加で採用してよい候補種別（裏拍の採用など） */
  chorusReasons: ReadonlySet<NoteReason>;
  /** 非サビの1小節あたり上限 */
  maxPerBar: number;
}

/** レベルごとに「どの種類の候補を採用するか」「小節あたり上限」を変える */
const LEVEL_PROFILES: Record<LevelNumber, LevelProfile> = {
  1: { reasons: new Set<NoteReason>(['downbeat', 'beat', 'onset']), chorusReasons: new Set<NoteReason>(), maxPerBar: 2 },
  2: { reasons: new Set<NoteReason>(['downbeat', 'beat', 'onset']), chorusReasons: new Set<NoteReason>(['offbeat']), maxPerBar: 4 },
  3: { reasons: new Set<NoteReason>(['downbeat', 'beat', 'offbeat', 'onset']), chorusReasons: new Set<NoteReason>(['subdivision']), maxPerBar: 6 },
  4: { reasons: new Set<NoteReason>(['downbeat', 'beat', 'offbeat', 'onset', 'subdivision']), chorusReasons: new Set<NoteReason>(), maxPerBar: 8 },
};

const BASE_WEIGHT: Record<string, number> = {
  downbeat: 1.0,
  beat: 0.75,
  offbeat: 0.45,
  onset: 0.6,
  subdivision: 0.4,
};

/** 次点候補として採用を許す下限（閾値に対する比率） */
const FILL_SCORE_RATIO = 0.5;

/** 候補採用の閾値（密度が高いほど低い） */
export function thresholdForDensity(density: number): number {
  const d = Math.min(1, Math.max(0, density));
  return 0.75 - 0.5 * d;
}

function candidateScore(base: number, onsetStrength: number): number {
  return base * (0.4 + 0.6 * Math.min(1, Math.max(0, onsetStrength)));
}

/**
 * 解析結果から全レベル共通の候補集合を作る。
 * 拍グリッド（小節頭・拍・裏拍・4分割）とオンセットを統合し、近接するオンセットでグリッド候補を強化する。
 */
export function buildCandidates(analysis: GenerationAnalysis, snapStrength: number): Candidate[] {
  const beats = analysis.beats;
  const downbeatSet = new Set(analysis.downbeats);
  const grid: Candidate[] = [];
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i]!;
    grid.push({ timeMs: t, reason: downbeatSet.has(t) ? 'downbeat' : 'beat', base: downbeatSet.has(t) ? BASE_WEIGHT.downbeat! : BASE_WEIGHT.beat!, onsetStrength: 0, score: 0 });
    if (i + 1 < beats.length) {
      const next = beats[i + 1]!;
      const len = next - t;
      if (len > 0) {
        grid.push({ timeMs: Math.round(t + len / 2), reason: 'offbeat', base: BASE_WEIGHT.offbeat!, onsetStrength: 0, score: 0 });
        grid.push({ timeMs: Math.round(t + len / 4), reason: 'subdivision', base: BASE_WEIGHT.subdivision!, onsetStrength: 0, score: 0 });
        grid.push({ timeMs: Math.round(t + (3 * len) / 4), reason: 'subdivision', base: BASE_WEIGHT.subdivision!, onsetStrength: 0, score: 0 });
      }
    }
  }
  grid.sort((a, b) => a.timeMs - b.timeMs);
  const gridTimes = grid.map((g) => g.timeMs);
  const tolerance = 70;
  const standalone: Candidate[] = [];
  for (const o of analysis.onsets) {
    const idx = nearestIndex(gridTimes, o.timeMs);
    const g = idx >= 0 ? grid[idx]! : null;
    if (g && Math.abs(g.timeMs - o.timeMs) <= tolerance) {
      if (o.strength > g.onsetStrength) {
        g.onsetStrength = o.strength;
        // スナップ強度に応じてオンセット位置とグリッド位置の間へ置く
        const gridTime = gridTimes[idx]!;
        g.timeMs = Math.round(o.timeMs + (gridTime - o.timeMs) * Math.min(1, Math.max(0, snapStrength)));
      }
    } else {
      standalone.push({ timeMs: o.timeMs, reason: 'onset', base: BASE_WEIGHT.onset!, onsetStrength: o.strength, score: 0 });
    }
  }
  const all = [...grid, ...standalone];
  for (const c of all) c.score = candidateScore(c.base, c.onsetStrength);
  all.sort((a, b) => a.timeMs - b.timeMs || b.score - a.score);
  return all;
}

function nearestIndex(sorted: number[], value: number): number {
  if (sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1]! - value) <= Math.abs(sorted[lo]! - value)) return lo - 1;
  return lo;
}

function barIndexer(analysis: GenerationAnalysis, durationMs: number): (timeMs: number) => number {
  const bars = analysis.downbeats.length >= 2 ? analysis.downbeats : analysis.beats.filter((_, i) => i % (analysis.beatsPerBar || 4) === 0);
  if (bars.length >= 2) {
    return (t) => {
      let lo = 0;
      let hi = bars.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid]! <= t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
  }
  const barMs = analysis.bpm > 0 ? (60000 / analysis.bpm) * (analysis.beatsPerBar || 4) : durationMs;
  return (t) => Math.floor(t / Math.max(1, barMs));
}

/** 1レベル分の音符を生成する。純粋関数で決定的。 */
export function generateLevel(level: LevelNumber, input: GenerationInput): ChartNote[] {
  return generateLevelDetailed(level, input).notes;
}

/** 1レベル分を生成し、目標数・除外数も返す */
export function generateLevelDetailed(level: LevelNumber, input: GenerationInput): LevelGenerationResult {
  const settings = input.settings?.[level] ?? DEFAULT_LEVEL_SETTINGS[level];
  const profile = LEVEL_PROFILES[level];
  const policy = input.manualPolicy ?? 'keep';
  const existing = input.existing?.[level] ?? [];
  const kept: ChartNote[] = policy === 'keep' ? existing.filter((n) => n.source === 'manual').map((n) => ({ ...n })) : [];
  // 保持する連打の区間（最小間隔ぶん広げる）には自動ヒットを置かない
  const blockedSpans = kept.filter((n) => n.type === 'mash' && n.durationMs).map((n) => ({ start: n.hitAtMs, end: n.hitAtMs + n.durationMs! }));
  const durationMs = input.durationMs;
  const minGap = Math.max(1, Math.round(settings.minGapMs));
  const threshold = thresholdForDensity(settings.density);
  const chorusMul = Math.max(1, settings.chorusDensityMultiplier);
  const barOf = barIndexer(input.analysis, durationMs);
  const start = Math.max(0, input.analysis.leadInEndMs - 20);
  const end = Math.min(durationMs, input.analysis.tailStartMs);
  const exclusionMs = input.crossLevelExclusionMs ?? CROSS_LEVEL_EXCLUSION_MS;
  const usedOther = (input.usedTimes ?? []).filter((u) => u.level !== level);

  const candidates = buildCandidates(input.analysis, settings.beatSnapStrength).filter(
    (c) => c.timeMs >= start && c.timeMs < end && c.timeMs >= 0 && c.timeMs < durationMs,
  );

  // スコア降順で貪欲に採用（同点は早い時刻）。衝突した候補は捨て、次点の候補が自然に採用される。
  // 閾値未満の候補は「他レベルとの重複で目標数に届かないとき」だけ、下限スコア以上の音楽的候補を次点として採用する。
  const ranked = candidates
    .map((c) => {
      const chorus = isInChorus(input.choruses, c.timeMs);
      return { c, chorus, effectiveThreshold: chorus ? threshold / chorusMul : threshold };
    })
    .filter((x) => profile.reasons.has(x.c.reason) || (x.chorus && profile.chorusReasons.has(x.c.reason)))
    .sort((a, b) => b.c.score - a.c.score || a.c.timeMs - b.c.timeMs);

  const select = (withExclusion: boolean, fillTarget: number): { generated: ChartNote[]; excluded: number } => {
    const accepted: number[] = kept.map((n) => n.hitAtMs).sort((a, b) => a - b);
    const barCounts = new Map<number, number>();
    for (const t of accepted) barCounts.set(barOf(t), (barCounts.get(barOf(t)) ?? 0) + 1);
    const generated: ChartNote[] = [];
    let excluded = 0;
    for (const { c, chorus, effectiveThreshold } of ranked) {
      if (c.score < effectiveThreshold) {
        // 次点候補: 目標数に満たない場合のみ、閾値の半分以上のスコアを持つ候補を採用する
        if (generated.length >= fillTarget || c.score < effectiveThreshold * FILL_SCORE_RATIO) continue;
      }
      if (!gapOk(accepted, c.timeMs, minGap)) continue;
      if (blockedSpans.some((sp) => c.timeMs >= sp.start - minGap && c.timeMs <= sp.end + minGap)) continue;
      const bar = barOf(c.timeMs);
      const cap = chorus ? Math.ceil(profile.maxPerBar * chorusMul) : profile.maxPerBar;
      const count = barCounts.get(bar) ?? 0;
      if (count >= cap) continue;
      if (withExclusion && usedOther.length > 0 && conflictsWithOtherLevel(c.timeMs, level, usedOther, exclusionMs)) {
        excluded++;
        continue;
      }
      insertSorted(accepted, c.timeMs);
      barCounts.set(bar, count + 1);
      generated.push({ id: '', hitAtMs: c.timeMs, source: 'generated', reason: c.reason, type: 'tap' });
    }
    return { generated, excluded };
  };

  // 目標数 = 難易度間除外なし・閾値のみで採用できた数
  const target = usedOther.length > 0 ? select(false, 0).generated.length : -1;
  const { generated, excluded } = select(true, target === -1 ? 0 : target);
  generated.sort((a, b) => a.hitAtMs - b.hitAtMs);
  const prefix = `l${level}-note-`;
  let seq = nextSeq(kept.map((n) => n.id), prefix);
  for (const n of generated) n.id = makeNoteId(level, seq++);
  const all = [...kept, ...generated].sort((a, b) => a.hitAtMs - b.hitAtMs);
  // 同時刻の重複は手作業音符を優先して除去
  const seen = new Set<number>();
  const notes = all.filter((n) => {
    if (seen.has(n.hitAtMs)) return false;
    seen.add(n.hitAtMs);
    return true;
  });
  return { level, notes, targetCount: target === -1 ? generated.length : target, generatedCount: generated.length, excludedByCrossLevel: excluded };
}

function gapOk(sortedTimes: number[], t: number, minGap: number): boolean {
  let lo = 0;
  let hi = sortedTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo < sortedTimes.length && sortedTimes[lo]! - t < minGap) return false;
  if (lo > 0 && t - sortedTimes[lo - 1]! < minGap) return false;
  return true;
}

function insertSorted(arr: number[], t: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, t);
}

/**
 * LEVEL_PRIORITY（1→2→3→4）の順に生成し、先に確定したレベルの音符を使用済み時刻として次のレベルから除外する。
 * `levels` に含まれないレベルの既存音符、および保持する手作業音符も最初から使用済みとして扱う。
 */
export function generateAllLevelsDetailed(input: GenerationInput, levels: readonly LevelNumber[] = LEVEL_NUMBERS): Partial<Record<LevelNumber, LevelGenerationResult>> {
  const policy = input.manualPolicy ?? 'keep';
  const used: UsedNoteTime[] = [...(input.usedTimes ?? [])];
  for (const l of LEVEL_NUMBERS) {
    const existing = input.existing?.[l] ?? [];
    const toUsed = (n: ChartNote): UsedNoteTime => ({ level: l, hitAtMs: n.hitAtMs, id: n.id, ...(n.type === 'mash' && n.durationMs ? { durationMs: n.durationMs } : {}) });
    if (!levels.includes(l)) {
      for (const n of existing) used.push(toUsed(n));
    } else if (policy === 'keep') {
      for (const n of existing) if (n.source === 'manual') used.push(toUsed(n));
    }
  }
  const out: Partial<Record<LevelNumber, LevelGenerationResult>> = {};
  for (const level of LEVEL_PRIORITY) {
    if (!levels.includes(level)) continue;
    const r = generateLevelDetailed(level, { ...input, usedTimes: used });
    out[level] = r;
    for (const n of r.notes) if (n.source !== 'manual') used.push({ level, hitAtMs: n.hitAtMs, id: n.id });
  }
  return out;
}

export function generateAllLevels(input: GenerationInput, levels: readonly LevelNumber[] = LEVEL_NUMBERS): Partial<Record<LevelNumber, ChartNote[]>> {
  const detailed = generateAllLevelsDetailed(input, levels);
  const out: Partial<Record<LevelNumber, ChartNote[]>> = {};
  for (const level of levels) out[level] = detailed[level]?.notes ?? [];
  return out;
}
