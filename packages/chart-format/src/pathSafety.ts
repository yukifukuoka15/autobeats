import { SUPPORTED_AUDIO_EXTENSIONS } from './constants';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * chart.json の audioFile が「書き出しフォルダ直下の単純なファイル名」であることを確認する。
 * ディレクトリ区切り、親参照、絶対パス、制御文字、予約名を拒否する。
 */
export function isSafeRelativeAudioFile(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (CONTROL_CHARS.test(name)) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (name.includes('..')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  if (name.trim() !== name) return false;
  const stem = name.replace(/\.[^.]*$/, '');
  if (WINDOWS_RESERVED.test(stem)) return false;
  return hasSupportedAudioExtension(name);
}

export function getExtensionLower(name: string): string {
  const m = /\.[^./\\]+$/.exec(name);
  return m ? m[0].toLowerCase() : '';
}

export function hasSupportedAudioExtension(name: string): boolean {
  const ext = getExtensionLower(name);
  return (SUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

const TRACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** trackId / 書き出しフォルダ名として安全か */
export function isValidTrackId(id: string): boolean {
  if (typeof id !== 'string') return false;
  if (!TRACK_ID_PATTERN.test(id)) return false;
  if (WINDOWS_RESERVED.test(id)) return false;
  return true;
}

/**
 * 任意の文字列から安全な trackId を生成する。
 * 日本語タイトルなど ASCII 以外しか含まない場合は fallback を使う。
 */
export function sanitizeTrackId(input: string, fallback = 'track'): string {
  const ascii = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/-+$/g, '');
  let candidate = ascii.length > 0 ? ascii : fallback;
  if (!/^[a-z0-9]/.test(candidate)) candidate = `t-${candidate}`.slice(0, 64);
  if (WINDOWS_RESERVED.test(candidate)) candidate = `${candidate}-track`;
  return isValidTrackId(candidate) ? candidate : fallback;
}
