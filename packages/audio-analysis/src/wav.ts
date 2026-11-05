/** WAV（RIFF）エンコード／デコード。テストと Node 側のフィクスチャ用。 */

export function encodeWav16(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numCh = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * numCh * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i] ?? 0));
      view.setInt16(off, v < 0 ? v * 32768 : v * 32767, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (off: number, len: number) => String.fromCharCode(...bytes.subarray(off, off + len));
  if (bytes.length < 44 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('WAV ではありません');
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: { start: number; length: number } | null = null;
  while (off + 8 <= bytes.length) {
    const id = str(off, 4);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      const format = view.getUint16(body, true);
      fmt = { format, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
      if (format === 0xfffe && size >= 26) fmt.format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { start: body, length: Math.min(size, bytes.length - body) };
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV のチャンクが不正です');
  const { channels: numCh, bits, format } = fmt;
  const bytesPer = bits / 8;
  const frames = Math.floor(data.length / (bytesPer * numCh));
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
  let p = data.start;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let v: number;
      if (format === 3 && bits === 32) v = view.getFloat32(p, true);
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 8) v = (view.getUint8(p) - 128) / 128;
      else if (bits === 24) {
        const b0 = view.getUint8(p);
        const b1 = view.getUint8(p + 1);
        const b2 = view.getInt8(p + 2);
        v = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
      } else if (bits === 32) v = view.getInt32(p, true) / 2147483648;
      else throw new Error(`未対応の WAV ビット深度: ${bits}`);
      channels[c]![i] = v;
      p += bytesPer;
    }
  }
  return { sampleRate: fmt.sampleRate, channels };
}
