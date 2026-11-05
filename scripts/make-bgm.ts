/**
 * サンプル曲をループ用 BGM として書き出す（曲頭・曲末の無音なし、小節境界で継ぎ目なくループ）。
 *   npx tsx scripts/make-bgm.ts <out.mp3>
 */
import { writeFileSync } from 'node:fs';
import { Mp3Encoder } from '@breezystack/lamejs';
import { synthesizeSongLike } from '../packages/audio-analysis/src/index';

const out = process.argv[2];
if (!out) throw new Error('usage: tsx scripts/make-bgm.ts <out.mp3>');
const sampleRate = 44100;
const song = synthesizeSongLike({
  bpm: 120,
  sampleRate,
  leadInSec: 0,
  tailSec: 0,
  sections: [
    { kind: 'intro', bars: 2 },
    { kind: 'verse', bars: 8 },
    { kind: 'chorus', bars: 8 },
    { kind: 'verse', bars: 8 },
    { kind: 'chorus', bars: 8 },
  ],
});
const toInt16 = (pcm: Float32Array) => {
  const o = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]!));
    o[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return o;
};
const left = toInt16(song.pcm);
const right = toInt16(song.pcm.map((v) => v * 0.9));
const enc = new Mp3Encoder(2, sampleRate, 160);
const chunks: Uint8Array[] = [];
for (let i = 0; i < left.length; i += 1152) {
  const buf = enc.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152));
  if (buf.length > 0) chunks.push(new Uint8Array(buf));
}
const end = enc.flush();
if (end.length > 0) chunks.push(new Uint8Array(end));
const total = chunks.reduce((s, c) => s + c.length, 0);
const bytes = new Uint8Array(total);
let off = 0;
for (const c of chunks) {
  bytes.set(c, off);
  off += c.length;
}
writeFileSync(out, bytes);
console.log(`written ${out} (${song.durationMs} ms, ${bytes.length} bytes)`);
