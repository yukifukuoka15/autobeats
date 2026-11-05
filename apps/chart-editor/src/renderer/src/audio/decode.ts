import { AUDIO_LIMITS } from '@autobeats/chart-format';

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

/** main が発行したトークンの URL から音声を取得し Web Audio でデコードする */
export async function fetchAndDecode(url: string, ctx: AudioContext): Promise<AudioBuffer> {
  let bytes: ArrayBuffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch (err) {
    throw new DecodeError(`音声ファイルを読み取れません（${(err as Error).message}）。`);
  }
  if (bytes.byteLength === 0) throw new DecodeError('音声ファイルが空です。');
  if (bytes.byteLength > AUDIO_LIMITS.maxFileBytes) throw new DecodeError('音声ファイルが大きすぎます。');
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    throw new DecodeError('この音声ファイルをデコードできません。壊れているか、対応していない形式です（MP3 / WAV / M4A / OGG に対応）。');
  }
  const durationMs = Math.round(buffer.duration * 1000);
  if (durationMs <= 0) throw new DecodeError('音声の長さが 0 秒です。');
  if (durationMs < AUDIO_LIMITS.minDurationMs) throw new DecodeError(`音声が短すぎます（${durationMs}ms）。1 秒以上の音声を読み込んでください。`);
  if (durationMs > AUDIO_LIMITS.maxDurationMs) throw new DecodeError(`音声が長すぎます（約 ${Math.round(durationMs / 60000)} 分）。上限は ${AUDIO_LIMITS.maxDurationMs / 60000} 分です。`);
  return buffer;
}
