import { describe, expect, it } from 'vitest';
import { youtubeUrl } from '../../src/main/services/youtube';

describe('YouTube URL input', () => {
  it('accepts shared text and short links', () => {
    expect(youtubeUrl('曲 https://youtu.be/abc?t=10')).toBe('https://youtu.be/abc?t=10');
    expect(youtubeUrl('https://music.youtube.com/watch?v=abc')).toContain('music.youtube.com');
  });
  it('rejects lookalike domains, local addresses and credentials', () => {
    for (const value of ['https://youtube.com.evil.test/watch?v=x', 'https://localhost/x', 'https://youtube.com@evil.test/x', 'https://user@youtube.com/x', 'https://youtube.com:8080/x', 'invalid']) {
      expect(() => youtubeUrl(value)).toThrow();
    }
  });
});
