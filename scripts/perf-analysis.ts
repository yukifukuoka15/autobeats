import { analyzeAudio, generateAllLevels, buildWaveformPeaks, synthesizeSongLike } from '../packages/audio-analysis/src/index';
async function run(minutes: number) {
  const sampleRate = 44100;
  const bars = Math.round((minutes * 60) / 2); // 120bpm: 2s per bar
  const sections = [] as { kind: 'verse' | 'chorus'; bars: number }[];
  for (let b = 0; b < bars; b += 16) sections.push({ kind: 'verse', bars: 8 }, { kind: 'chorus', bars: 8 });
  const t0 = performance.now();
  const song = synthesizeSongLike({ bpm: 120, sampleRate, sections });
  const t1 = performance.now();
  const peaks = buildWaveformPeaks([song.pcm, song.pcm], sampleRate);
  const t2 = performance.now();
  const r = await analyzeAudio({ sampleRate, channels: [song.pcm, song.pcm] });
  const t3 = performance.now();
  const levels = generateAllLevels({ analysis: r, choruses: r.choruses, durationMs: r.durationMs });
  const t4 = performance.now();
  console.log(`${minutes}min: synth ${(t1 - t0).toFixed(0)}ms peaks ${(t2 - t1).toFixed(0)}ms analyze ${(t3 - t2).toFixed(0)}ms generate ${(t4 - t3).toFixed(0)}ms | bpm ${r.bpm} beats ${r.beats.length} onsets ${r.onsets.length} choruses ${r.choruses.length} notes L1-4 ${[1,2,3,4].map(l => levels[l as 1]!.length).join('/')} peaksLevels ${peaks.levels.length} rss ${(process.memoryUsage().rss/1e6).toFixed(0)}MB`);
}
await run(5);
await run(29);
