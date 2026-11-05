/**
 * テスト・E2E 用の合成音声フィクスチャを生成する（著作物を含まない）。
 *   npm run fixtures
 * 出力: fixtures/generated/*.wav, *.mp3
 */
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mp3Encoder } from '@breezystack/lamejs';
import { encodeWav16, silence, sine, synthesizeClickTrack, synthesizeSongLike } from '../packages/audio-analysis/src/index';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'fixtures', 'generated');

function toInt16(pcm: Float32Array): Int16Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]!));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

function encodeMp3(channels: Float32Array[], sampleRate: number, kbps = 128): Uint8Array {
  const encoder = new Mp3Encoder(channels.length, sampleRate, kbps);
  const left = toInt16(channels[0]!);
  const right = channels[1] ? toInt16(channels[1]) : undefined;
  const chunks: Uint8Array[] = [];
  const block = 1152;
  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block);
    const r = right ? right.subarray(i, i + block) : undefined;
    const buf = r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
    if (buf.length > 0) chunks.push(new Uint8Array(buf));
  }
  const end = encoder.flush();
  if (end.length > 0) chunks.push(new Uint8Array(end));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sampleRate = 44100;
  const song = synthesizeSongLike({
    bpm: 120,
    sampleRate,
    leadInSec: 0.5,
    tailSec: 0.5,
    sections: [
      { kind: 'intro', bars: 2 },
      { kind: 'verse', bars: 8 },
      { kind: 'chorus', bars: 8 },
      { kind: 'verse', bars: 8 },
      { kind: 'chorus', bars: 8 },
    ],
  });
  // 擬似ステレオ（右チャンネルをわずかに減衰）
  const right = song.pcm.map((v) => v * 0.9);
  await writeFile(path.join(outDir, 'song.wav'), encodeWav16([song.pcm, right], sampleRate));
  await writeFile(path.join(outDir, 'song.mp3'), encodeMp3([song.pcm, right], sampleRate));
  await writeFile(path.join(outDir, 'song.sections.json'), JSON.stringify({ bpm: 120, durationMs: song.durationMs, sections: song.sectionsMs }, null, 2));

  const click = synthesizeClickTrack({ bpm: 120, durationSec: 20, sampleRate });
  await writeFile(path.join(outDir, 'click120.wav'), encodeWav16([click], sampleRate));
  await writeFile(path.join(outDir, 'click120.mp3'), encodeMp3([click], sampleRate));

  await writeFile(path.join(outDir, 'silence.wav'), encodeWav16([silence(5, sampleRate)], sampleRate));
  await writeFile(path.join(outDir, 'short.wav'), encodeWav16([sine(440, 0.3, sampleRate)], sampleRate));
  await writeFile(path.join(outDir, 'broken.mp3'), new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5]));
  console.log(`fixtures written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
