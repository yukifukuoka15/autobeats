import { AUDIO_LIMITS, getExtensionLower, hasSupportedAudioExtension } from '@autobeats/chart-format';
import { sha256File } from '@autobeats/chart-format/node';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AudioFileInfo {
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

export class AudioFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioFileError';
  }
}

/** 音声ファイルを検査し、ハッシュ付きの情報を返す。問題があれば日本語メッセージの AudioFileError */
export async function inspectAudioFile(filePath: string): Promise<AudioFileInfo> {
  if (!path.isAbsolute(filePath)) throw new AudioFileError('絶対パスではありません。');
  if (!hasSupportedAudioExtension(filePath)) {
    throw new AudioFileError(`対応していない拡張子です（${getExtensionLower(filePath) || '拡張子なし'}）。MP3 / WAV / M4A / OGG を選択してください。`);
  }
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new AudioFileError('ファイルが見つかりません。');
  }
  if (!stat.isFile()) throw new AudioFileError('通常のファイルではありません。');
  if (stat.size === 0) throw new AudioFileError('ファイルが空（0 バイト）です。');
  if (stat.size > AUDIO_LIMITS.maxFileBytes) {
    throw new AudioFileError(`ファイルサイズが上限（${Math.round(AUDIO_LIMITS.maxFileBytes / 1024 / 1024)}MB）を超えています。`);
  }
  const sha256 = await sha256File(filePath);
  return {
    path: filePath,
    fileName: path.basename(filePath),
    extension: getExtensionLower(filePath),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256,
  };
}

/** 表示用にホームディレクトリを ~ に置き換える（macOS / Windows 共通） */
export function displayPath(p: string, home = os.homedir()): string {
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
