import { describe, expect, it } from 'vitest';
import { CHART_FORMAT, validateChart, parseAndValidateChart, type ChartFile } from '../src';

export function sampleChart(overrides: Partial<ChartFile> = {}): ChartFile {
  return {
    format: CHART_FORMAT,
    formatVersion: 1,
    trackId: 'sample-track',
    title: '曲名',
    artist: '',
    audioFile: 'audio.mp3',
    audioSha256: 'a'.repeat(64),
    durationMs: 180000,
    bpm: 128,
    offsetMs: 0,
    analysis: { engineVersion: '1.0.0', analyzedAt: '2026-11-05T00:00:00.000Z' },
    choruses: [{ id: 'chorus-1', startMs: 45000, endMs: 75000, confidence: 0.82, source: 'detected' }],
    levels: {
      '1': { displayName: 'LEVEL 1', notes: [{ id: 'l1-note-1', hitAtMs: 1250, source: 'generated', reason: 'downbeat' }] },
      '2': { displayName: 'LEVEL 2', notes: [] },
      '3': { displayName: 'LEVEL 3', notes: [] },
      '4': { displayName: 'LEVEL 4', notes: [] },
    },
    ...overrides,
  };
}

describe('validateChart', () => {
  it('正常な譜面を受け入れ、音符を時刻順へ正規化する', () => {
    const chart = sampleChart();
    chart.levels['2'].notes = [
      { id: 'b', hitAtMs: 5000, source: 'manual' },
      { id: 'a', hitAtMs: 2000, source: 'generated', reason: 'beat' },
    ];
    const r = validateChart(chart);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chart.levels['2'].notes.map((n) => n.id)).toEqual(['a', 'b']);
    // 入力は変更されない
    expect(chart.levels['2'].notes[0]!.id).toBe('b');
  });

  it('format 不一致を拒否する', () => {
    const r = validateChart({ ...sampleChart(), format: 'other' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('format');
  });

  it('未知の formatVersion を日本語で拒否する', () => {
    const r = validateChart({ ...sampleChart(), formatVersion: 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('unsupported-version');
    expect(r.errors[0]!.message).toContain('非対応');
  });

  it('レベルが欠けていれば拒否する', () => {
    const chart = sampleChart() as unknown as { levels: Record<string, unknown> };
    delete chart.levels['4'];
    const r = validateChart(chart);
    expect(r.ok).toBe(false);
  });

  it('同一レベルの hitAtMs 重複を拒否する', () => {
    const chart = sampleChart();
    chart.levels['1'].notes = [
      { id: 'x', hitAtMs: 1000, source: 'generated' },
      { id: 'y', hitAtMs: 1000, source: 'generated' },
    ];
    const r = validateChart(chart);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.code === 'note-time-dup')).toBe(true);
  });

  it('音符IDの重複を拒否する', () => {
    const chart = sampleChart();
    chart.levels['1'].notes = [
      { id: 'x', hitAtMs: 1000, source: 'generated' },
      { id: 'x', hitAtMs: 2000, source: 'generated' },
    ];
    expect(validateChart(chart).ok).toBe(false);
  });

  it('曲の範囲外の音符を拒否する', () => {
    const chart = sampleChart();
    chart.levels['1'].notes = [{ id: 'x', hitAtMs: 180000, source: 'generated' }];
    expect(validateChart(chart).ok).toBe(false);
    chart.levels['1'].notes = [{ id: 'x', hitAtMs: -1, source: 'generated' }];
    expect(validateChart(chart).ok).toBe(false);
  });

  it('非整数の hitAtMs を拒否する', () => {
    const chart = sampleChart();
    chart.levels['1'].notes = [{ id: 'x', hitAtMs: 1000.5, source: 'generated' }];
    expect(validateChart(chart).ok).toBe(false);
  });

  it('BPM の範囲を検証する', () => {
    expect(validateChart(sampleChart({ bpm: 20 })).ok).toBe(false);
    expect(validateChart(sampleChart({ bpm: 301 })).ok).toBe(false);
    expect(validateChart(sampleChart({ bpm: 30 })).ok).toBe(true);
  });

  it('サビ区間の範囲と順序を検証する', () => {
    expect(validateChart(sampleChart({ choruses: [{ id: 'c', startMs: 10, endMs: 5, confidence: 1, source: 'manual' }] })).ok).toBe(false);
    expect(validateChart(sampleChart({ choruses: [{ id: 'c', startMs: 10, endMs: 999999, confidence: 1, source: 'manual' }] })).ok).toBe(false);
    const overlap = validateChart(
      sampleChart({
        choruses: [
          { id: 'c1', startMs: 1000, endMs: 5000, confidence: 1, source: 'manual' },
          { id: 'c2', startMs: 4000, endMs: 8000, confidence: 1, source: 'manual' },
        ],
      }),
    );
    expect(overlap.ok).toBe(false);
  });

  it('audioFile の ../ や絶対パスを拒否する', () => {
    expect(validateChart(sampleChart({ audioFile: '../audio.mp3' })).ok).toBe(false);
    expect(validateChart(sampleChart({ audioFile: '/etc/audio.mp3' })).ok).toBe(false);
    expect(validateChart(sampleChart({ audioFile: 'sub/audio.mp3' })).ok).toBe(false);
    expect(validateChart(sampleChart({ audioFile: 'audio.txt' })).ok).toBe(false);
    expect(validateChart(sampleChart({ audioFile: 'audio.wav' })).ok).toBe(true);
  });

  it('trackId の不正文字を拒否する', () => {
    expect(validateChart(sampleChart({ trackId: '../x' })).ok).toBe(false);
    expect(validateChart(sampleChart({ trackId: 'Bad Name' })).ok).toBe(false);
    expect(validateChart(sampleChart({ trackId: 'ok_name-1' })).ok).toBe(true);
  });

  it('SHA-256 の書式を検証する', () => {
    expect(validateChart(sampleChart({ audioSha256: 'xyz' })).ok).toBe(false);
    expect(validateChart(sampleChart({ audioSha256: 'A'.repeat(64) })).ok).toBe(false);
  });

  it('最小間隔違反と早すぎる音符を警告する', () => {
    const chart = sampleChart();
    chart.levels['1'].notes = [
      { id: 'a', hitAtMs: 1000, source: 'manual' },
      { id: 'b', hitAtMs: 1100, source: 'manual' },
    ];
    const r = validateChart(chart, { minGapMsByLevel: { '1': 600 } });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === 'note-min-gap')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'note-early')).toBe(true);
  });

  it('壊れた JSON 文字列を拒否する', () => {
    const r = parseAndValidateChart('{ not json');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('json-parse');
  });

  it('追加フィールドは許可する', () => {
    const r = validateChart({ ...sampleChart(), extra: { future: true } });
    expect(r.ok).toBe(true);
  });
});

it('Lv4が空でも検証に成功し、使わないLv4の空欄警告を出さない', () => {
  const chart = sampleChart();
  chart.levels['4'].notes = [];
  const r = validateChart(chart);
  expect(r.ok).toBe(true);
  expect(r.warnings.some(w => w.code === 'level-empty' && w.path === 'levels.4')).toBe(false);
  chart.levels['2'].notes = [];
  const other = validateChart(chart);
  expect(other.warnings.some(w => w.code === 'level-empty' && w.path === 'levels.2')).toBe(true);
});
