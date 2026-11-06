import { AUDIO_LIMITS, BPM_RANGE, CHART_FORMAT, JUDGE, LEVEL_KEYS, MASH, SUPPORTED_FORMAT_VERSIONS } from './constants';
import { findCrossLevelConflicts } from './crossLevel';
import { noteEndMs } from './noteSpan';
import { isSafeRelativeAudioFile, isValidTrackId } from './pathSafety';
import { chartFileV1Schema, chartHeaderSchema } from './schema';
import type { ChartFile, ChartIssue, ChartNote, ChorusSection, LevelKey } from './types';

export type ChartValidationResult =
  | { ok: true; chart: ChartFile; warnings: ChartIssue[] }
  | { ok: false; errors: ChartIssue[]; warnings: ChartIssue[] };

export interface ValidateChartOptions {
  /** レベルごとの最小間隔。未指定なら間隔検査をしない */
  minGapMsByLevel?: Partial<Record<LevelKey, number>>;
  /** true なら最小間隔違反を警告ではなくエラーにする（エディターの書き出し前検証用） */
  minGapAsError?: boolean;
  /**
   * 難易度間除外幅（ms）。指定すると異なるレベル間で |差| <= この値の音符をエラーにする。
   * 未指定なら難易度間検査をしない（既存データの読み込み互換のため）。
   */
  crossLevelExclusionMs?: number;
}

/**
 * 不明な JSON 値を検証し、正規化済みの ChartFile を返す。
 * 正規化: 音符を hitAtMs 昇順に並べ替え、サビ区間を開始順に並べ替える。
 * 入力オブジェクトは変更しない。
 */
export function validateChart(input: unknown, options: ValidateChartOptions = {}): ChartValidationResult {
  const errors: ChartIssue[] = [];
  const warnings: ChartIssue[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail([{ code: 'not-object', message: '譜面JSONがオブジェクトではありません。' }], warnings);
  }

  const header = chartHeaderSchema.safeParse(input);
  if (!header.success) {
    return fail([{ code: 'header', message: 'format と formatVersion が読み取れません。' }], warnings);
  }
  if (header.data.format !== CHART_FORMAT) {
    return fail(
      [{ code: 'format', message: `format が "${CHART_FORMAT}" ではありません（"${header.data.format}"）。`, path: 'format' }],
      warnings,
    );
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(header.data.formatVersion)) {
    return fail(
      [
        {
          code: 'unsupported-version',
          message: `formatVersion ${header.data.formatVersion} はこのアプリでは非対応です（対応: ${SUPPORTED_FORMAT_VERSIONS.join(', ')}）。新しいバージョンのアプリで開いてください。`,
          path: 'formatVersion',
        },
      ],
      warnings,
    );
  }

  const parsed = chartFileV1Schema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: 'schema',
        message: `構造エラー: ${issue.path.join('.') || '(root)'}: ${translateZodMessage(issue.message)}`,
        path: issue.path.join('.'),
      });
    }
    return fail(errors, warnings);
  }

  const raw = parsed.data;

  if (!isValidTrackId(raw.trackId)) {
    errors.push({ code: 'track-id', message: `trackId "${raw.trackId}" に使用できない文字が含まれています（英小文字・数字・-・_ のみ、64文字以内）。`, path: 'trackId' });
  }
  if (!isSafeRelativeAudioFile(raw.audioFile)) {
    errors.push({ code: 'audio-file', message: `audioFile "${raw.audioFile}" は書き出しフォルダ直下の対応音声ファイル名である必要があります。`, path: 'audioFile' });
  }
  if (raw.durationMs > AUDIO_LIMITS.maxDurationMs) {
    errors.push({ code: 'duration', message: `durationMs が上限（${AUDIO_LIMITS.maxDurationMs}ms）を超えています。`, path: 'durationMs' });
  }
  if (raw.bpm < BPM_RANGE.min || raw.bpm > BPM_RANGE.max) {
    errors.push({ code: 'bpm', message: `BPM は ${BPM_RANGE.min}～${BPM_RANGE.max} の範囲である必要があります。`, path: 'bpm' });
  }

  // サビ区間
  const choruses: ChorusSection[] = raw.choruses.map((c) => ({ ...c }));
  const chorusIds = new Set<string>();
  choruses.forEach((c, i) => {
    const p = `choruses[${i}]`;
    if (chorusIds.has(c.id)) errors.push({ code: 'chorus-id-dup', message: `サビ区間ID "${c.id}" が重複しています。`, path: p });
    chorusIds.add(c.id);
    if (c.startMs < 0 || c.endMs > raw.durationMs) errors.push({ code: 'chorus-range', message: `サビ区間 ${c.id} が曲の範囲外です。`, path: p });
    if (!(c.startMs < c.endMs)) errors.push({ code: 'chorus-order', message: `サビ区間 ${c.id} は startMs < endMs である必要があります。`, path: p });
  });
  choruses.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  for (let i = 1; i < choruses.length; i++) {
    const prev = choruses[i - 1]!;
    const cur = choruses[i]!;
    if (cur.startMs < prev.endMs) {
      errors.push({ code: 'chorus-overlap', message: `サビ区間 ${prev.id} と ${cur.id} が重なっています。書き出し前に結合または解消してください。`, path: `choruses` });
    }
  }

  // レベル
  const levels = {} as Record<LevelKey, { displayName: string; notes: ChartNote[] }>;
  for (const key of LEVEL_KEYS) {
    const level = raw.levels[key];
    const notes: ChartNote[] = level.notes.map((n) => ({ ...n }));
    const ids = new Set<string>();
    const times = new Set<number>();
    notes.forEach((n, i) => {
      const p = `levels.${key}.notes[${i}]`;
      if (ids.has(n.id)) errors.push({ code: 'note-id-dup', message: `LEVEL ${key} の音符ID "${n.id}" が重複しています。`, path: p });
      ids.add(n.id);
      if (n.hitAtMs < 0 || n.hitAtMs >= raw.durationMs) {
        errors.push({ code: 'note-range', message: `LEVEL ${key} のヒット ${n.id}（${n.hitAtMs}ms）が曲の範囲外です。`, path: p });
      }
      if (times.has(n.hitAtMs)) {
        errors.push({ code: 'note-time-dup', message: `LEVEL ${key} で ${n.hitAtMs}ms のヒットが重複しています。`, path: p });
      }
      times.add(n.hitAtMs);
      if (n.type === 'mash') {
        if (!n.durationMs || n.durationMs < MASH.minDurationMs) {
          errors.push({ code: 'mash-duration', message: `LEVEL ${key} の連打 ${n.id} の長さ（durationMs）は ${MASH.minDurationMs}ms 以上の整数である必要があります。`, path: p });
        } else if (n.hitAtMs + n.durationMs > raw.durationMs) {
          errors.push({ code: 'mash-range', message: `LEVEL ${key} の連打 ${n.id} の終了（${n.hitAtMs + n.durationMs}ms）が曲の範囲外です。`, path: p });
        }
      } else if (n.type !== undefined && n.type !== 'tap') {
        warnings.push({ code: 'note-type', message: `LEVEL ${key} のヒット ${n.id} の type "${n.type}" はこのバージョンでは通常ヒットとして扱います。`, path: p });
      }
    });
    notes.sort((a, b) => a.hitAtMs - b.hitAtMs || a.id.localeCompare(b.id));
    const minGap = options.minGapMsByLevel?.[key];
    for (let i = 1; i < notes.length; i++) {
      // 連打は終了時刻から次のヒットまでの間隔で測る。区間内に別のヒットがあれば重複
      const prevEnd = noteEndMs(notes[i - 1]!);
      if (notes[i]!.hitAtMs <= prevEnd && notes[i - 1]!.type === 'mash') {
        errors.push({ code: 'mash-overlap', message: `LEVEL ${key} の連打 ${notes[i - 1]!.id} の区間内に ${notes[i]!.hitAtMs}ms のヒットがあります。`, path: `levels.${key}` });
        continue;
      }
      const gap = notes[i]!.hitAtMs - prevEnd;
      if (minGap !== undefined && gap < minGap) {
        (options.minGapAsError ? errors : warnings).push({ code: 'note-min-gap', message: `LEVEL ${key} の ${notes[i - 1]!.hitAtMs}ms と ${notes[i]!.hitAtMs}ms の間隔（${gap}ms）が最小間隔 ${minGap}ms を下回っています。`, path: `levels.${key}` });
      }
    }
    const early = notes.filter((n) => n.hitAtMs < JUDGE.approachMs).length;
    if (early > 0) {
      warnings.push({ code: 'note-early', message: `LEVEL ${key} に ${JUDGE.approachMs}ms より前のヒットが ${early} 個あります。ゲームでは開始時にレーン途中へ出現します。`, path: `levels.${key}` });
    }
    if (notes.length === 0 && key !== '4') {
      warnings.push({ code: 'level-empty', message: `LEVEL ${key} にヒットがありません。`, path: `levels.${key}` });
    }
    levels[key] = { displayName: level.displayName, notes };
  }

  if (options.crossLevelExclusionMs !== undefined) {
    const report = findCrossLevelConflicts(levels, options.crossLevelExclusionMs);
    for (const p of report.pairs) {
      errors.push({
        code: 'cross-level',
        message: `LEVEL ${p.levelA} の ${p.noteA.hitAtMs}ms（${p.noteA.id}）と LEVEL ${p.levelB} の ${p.noteB.hitAtMs}ms（${p.noteB.id}）の間隔が ${p.diffMs}ms で、難易度間除外幅 ${options.crossLevelExclusionMs}ms 以内です。`,
        path: `levels.${p.levelA}/${p.levelB}`,
      });
    }
  }

  if (errors.length > 0) return fail(errors, warnings);

  const chart: ChartFile = {
    format: CHART_FORMAT,
    formatVersion: 1,
    trackId: raw.trackId,
    title: raw.title,
    artist: raw.artist,
    audioFile: raw.audioFile,
    audioSha256: raw.audioSha256,
    durationMs: raw.durationMs,
    bpm: raw.bpm,
    offsetMs: raw.offsetMs,
    analysis: { engineVersion: raw.analysis.engineVersion, analyzedAt: raw.analysis.analyzedAt },
    choruses,
    levels,
    ...(raw.generationRules ? { generationRules: { ...raw.generationRules, levelPriority: [...raw.generationRules.levelPriority] } } : {}),
  };
  return { ok: true, chart, warnings };
}

function fail(errors: ChartIssue[], warnings: ChartIssue[]): ChartValidationResult {
  return { ok: false, errors, warnings };
}

function translateZodMessage(message: string): string {
  if (/expected number/i.test(message)) return '数値が必要です';
  if (/expected string/i.test(message)) return '文字列が必要です';
  if (/expected int/i.test(message)) return '整数が必要です';
  if (/expected array/i.test(message)) return '配列が必要です';
  if (/expected object/i.test(message)) return 'オブジェクトが必要です';
  if (/Invalid input: expected/i.test(message)) return '型が一致しません';
  if (/required/i.test(message)) return '必須項目です';
  if (/Too big/i.test(message)) return '値が大きすぎます';
  if (/Too small/i.test(message)) return '値が小さすぎます';
  if (/Invalid option/i.test(message)) return '許可されていない値です';
  return message;
}

/** JSON 文字列から検証する（サイズ上限・パース失敗を日本語で返す） */
export function parseAndValidateChart(text: string, options?: ValidateChartOptions): ChartValidationResult {
  if (text.length > AUDIO_LIMITS.maxChartJsonBytes) {
    return { ok: false, errors: [{ code: 'too-large', message: 'chart.json が大きすぎます。' }], warnings: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ code: 'json-parse', message: 'chart.json を JSON として読み取れません。' }], warnings: [] };
  }
  return validateChart(json, options);
}

/** ChartFile を人が読める整形 JSON へ変換する */
export function serializeChart(chart: ChartFile): string {
  return JSON.stringify(chart, null, 2) + '\n';
}
