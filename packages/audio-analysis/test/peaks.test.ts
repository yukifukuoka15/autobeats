import { describe, expect, it } from 'vitest';
import { buildWaveformPeaks, pickPeakLevel, sine, decodeWav, encodeWav16 } from '../src';

describe('waveform peaks', () => {
  it('複数解像度のピークを作り、ズームに応じて選べる', () => {
    const pcm = sine(440, 2, 44100, 0.8);
    const peaks = buildWaveformPeaks([pcm, pcm], 44100);
    expect(peaks.levels.length).toBe(5);
    expect(peaks.levels[0]!.min.length).toBe(Math.ceil(pcm.length / 64));
    expect(Math.max(...Array.from(peaks.levels[2]!.max))).toBeCloseTo(0.8, 1);
    expect(Math.min(...Array.from(peaks.levels[2]!.min))).toBeCloseTo(-0.8, 1);
    expect(pickPeakLevel(peaks, 100).samplesPerBin).toBe(64);
    expect(pickPeakLevel(peaks, 5000).samplesPerBin).toBe(4096);
    expect(pickPeakLevel(peaks, 10).samplesPerBin).toBe(64);
  });
});

describe('wav codec', () => {
  it('16bit WAV を往復できる', () => {
    const l = sine(440, 0.1, 8000, 0.5);
    const r = sine(880, 0.1, 8000, 0.25);
    const bytes = encodeWav16([l, r], 8000);
    const d = decodeWav(bytes);
    expect(d.sampleRate).toBe(8000);
    expect(d.channels.length).toBe(2);
    expect(d.channels[0]!.length).toBe(l.length);
    expect(d.channels[0]![10]).toBeCloseTo(l[10]!, 3);
    expect(d.channels[1]![10]).toBeCloseTo(r[10]!, 3);
    expect(() => decodeWav(new Uint8Array(10))).toThrow();
  });
});
