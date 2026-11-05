import { describe, expect, it } from 'vitest';
import { isSafeRelativeAudioFile, isValidTrackId, sanitizeTrackId } from '../src';

describe('pathSafety', () => {
  it('安全なファイル名だけを通す', () => {
    expect(isSafeRelativeAudioFile('audio.mp3')).toBe(true);
    expect(isSafeRelativeAudioFile('My Song.wav')).toBe(true);
    expect(isSafeRelativeAudioFile('../audio.mp3')).toBe(false);
    expect(isSafeRelativeAudioFile('..\\audio.mp3')).toBe(false);
    expect(isSafeRelativeAudioFile('/audio.mp3')).toBe(false);
    expect(isSafeRelativeAudioFile('C:audio.mp3')).toBe(false);
    expect(isSafeRelativeAudioFile('.hidden.mp3')).toBe(false);
    expect(isSafeRelativeAudioFile('a\u0000.mp3')).toBe(false);
    expect(isSafeRelativeAudioFile('con.mp3')).toBe(false);
    expect(isSafeRelativeAudioFile('audio.exe')).toBe(false);
    expect(isSafeRelativeAudioFile('')).toBe(false);
  });

  it('trackId を検証・生成する', () => {
    expect(isValidTrackId('sample-track')).toBe(true);
    expect(isValidTrackId('-bad')).toBe(false);
    expect(isValidTrackId('a'.repeat(65))).toBe(false);
    expect(isValidTrackId('con')).toBe(false);
    expect(sanitizeTrackId('My Great Song!!')).toBe('my-great-song');
    expect(sanitizeTrackId('サビ')).toBe('track');
    expect(sanitizeTrackId('サビ', 'song-1')).toBe('song-1');
    expect(sanitizeTrackId('../../etc')).toBe('etc');
    expect(isValidTrackId(sanitizeTrackId('CON'))).toBe(true);
  });
});
