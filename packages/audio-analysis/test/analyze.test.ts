import { describe, expect, it } from 'vitest';
import {
  AnalysisCancelledError,
  AudioInputError,
  analyzeAudio,
  silence,
  sine,
  synthesizeClickTrack,
  synthesizeSongLike,
  validateAnalysisInput,
} from '../src';

describe('analyzeAudio', () => {
  it('既知 BPM のクリック音から BPM と拍位置を推定できる', async () => {
    const bpm = 120;
    const sampleRate = 22050;
    const pcm = synthesizeClickTrack({ bpm, durationSec: 20, sampleRate, startOffsetSec: 0.25 });
    const r = await analyzeAudio({ sampleRate, channels: [pcm] });
    expect(Math.abs(r.bpm - bpm)).toBeLessThan(1);
    expect(r.beats.length).toBeGreaterThan(30);
    // 各拍が真のクリック位置（250ms + n*500ms）から 40ms 以内
    let aligned = 0;
    for (const b of r.beats) {
      const phase = ((b - 250) % 500 + 500) % 500;
      const dist = Math.min(phase, 500 - phase);
      if (dist <= 40) aligned++;
    }
    expect(aligned / r.beats.length).toBeGreaterThan(0.9);
    expect(r.beats).toEqual([...r.beats].sort((a, b) => a - b));
  });

  it('別テンポ（92 BPM）でも推定できる', async () => {
    const sampleRate = 22050;
    const pcm = synthesizeClickTrack({ bpm: 92, durationSec: 20, sampleRate });
    const r = await analyzeAudio({ sampleRate, channels: [pcm] });
    expect(Math.abs(r.bpm - 92)).toBeLessThan(1.5);
  });

  it('一定間隔のオンセットを検出できる', async () => {
    const sampleRate = 22050;
    const pcm = synthesizeClickTrack({ bpm: 120, durationSec: 10, sampleRate, accentEvery: 0 });
    const r = await analyzeAudio({ sampleRate, channels: [pcm] });
    // 20 クリック（0, 500, ..., 9500ms）
    const expected = Array.from({ length: 20 }, (_, i) => i * 500);
    const hits = expected.filter((t) => r.onsets.some((o) => Math.abs(o.timeMs - t) <= 40));
    expect(hits.length).toBeGreaterThanOrEqual(18);
    // 余計なオンセットが多すぎない
    expect(r.onsets.length).toBeLessThan(30);
  });

  it('無音では拍・オンセット・サビを生成しない', async () => {
    const sampleRate = 22050;
    const r = await analyzeAudio({ sampleRate, channels: [silence(10, sampleRate)] });
    expect(r.onsets.length).toBe(0);
    expect(r.beats.length).toBe(0);
    expect(r.choruses.length).toBe(0);
    expect(r.leadInEndMs).toBe(r.durationMs);
  });

  it('短すぎる・壊れた・非対応の入力を拒否する', () => {
    expect(() => validateAnalysisInput({ sampleRate: 44100, channels: [sine(440, 0.5, 44100)] })).toThrow(AudioInputError);
    expect(() => validateAnalysisInput({ sampleRate: 1000, channels: [sine(440, 2, 1000)] })).toThrow(AudioInputError);
    expect(() => validateAnalysisInput({ sampleRate: 44100, channels: [] })).toThrow(AudioInputError);
    const corrupt = sine(440, 2, 44100);
    corrupt.fill(NaN);
    expect(() => validateAnalysisInput({ sampleRate: 44100, channels: [corrupt] })).toThrow(AudioInputError);
    const stereoMismatch = { sampleRate: 44100, channels: [sine(440, 2, 44100), sine(440, 1, 44100)] };
    expect(() => validateAnalysisInput(stereoMismatch)).toThrow(AudioInputError);
  });

  it('キャンセルすると AnalysisCancelledError を投げる', async () => {
    const sampleRate = 22050;
    const pcm = synthesizeClickTrack({ bpm: 120, durationSec: 30, sampleRate });
    let calls = 0;
    await expect(analyzeAudio({ sampleRate, channels: [pcm] }, { isCancelled: () => ++calls > 2 })).rejects.toThrow(AnalysisCancelledError);
  });

  it('構造を持つ合成曲でサビ候補が真のサビ区間と重なり、範囲内で重複しない', async () => {
    const sampleRate = 22050;
    const song = synthesizeSongLike({
      bpm: 128,
      sampleRate,
      leadInSec: 1,
      tailSec: 1,
      sections: [
        { kind: 'intro', bars: 4 },
        { kind: 'verse', bars: 8 },
        { kind: 'chorus', bars: 8 },
        { kind: 'verse', bars: 8 },
        { kind: 'chorus', bars: 8 },
        { kind: 'bridge', bars: 4 },
        { kind: 'chorus', bars: 8 },
      ],
    });
    const r = await analyzeAudio({ sampleRate, channels: [song.pcm] });
    expect(Math.abs(r.bpm - 128)).toBeLessThan(1.5);
    expect(r.leadInEndMs).toBeLessThan(1200);
    expect(r.leadInEndMs).toBeGreaterThan(700);
    expect(r.choruses.length).toBeGreaterThan(0);
    for (const c of r.choruses) {
      expect(c.startMs).toBeGreaterThanOrEqual(0);
      expect(c.endMs).toBeLessThanOrEqual(r.durationMs);
      expect(c.startMs).toBeLessThan(c.endMs);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      expect(c.source).toBe('detected');
    }
    for (let i = 1; i < r.choruses.length; i++) expect(r.choruses[i]!.startMs).toBeGreaterThanOrEqual(r.choruses[i - 1]!.endMs);
    // 真のサビの合計時間のうち、候補でカバーされた割合
    const trueChorus = song.sectionsMs.filter((s) => s.kind === 'chorus');
    const overlap = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
    const covered = trueChorus.reduce((s, t) => s + r.choruses.reduce((x, c) => x + overlap(t, c), 0), 0);
    const trueTotal = trueChorus.reduce((s, t) => s + (t.endMs - t.startMs), 0);
    const candTotal = r.choruses.reduce((s, c) => s + (c.endMs - c.startMs), 0);
    const recall = covered / trueTotal;
    const precision = covered / candTotal;
    console.log('chorus candidates', r.choruses.map((c) => `${c.startMs}-${c.endMs} (${c.confidence.toFixed(2)})`), 'true', trueChorus.map((t) => `${t.startMs}-${t.endMs}`), { recall, precision });
    expect(recall).toBeGreaterThan(0.5);
    expect(precision).toBeGreaterThan(0.5);
  }, 120000);
});
