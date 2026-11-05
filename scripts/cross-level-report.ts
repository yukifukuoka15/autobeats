/**
 * chart.json の難易度間衝突（|差| <= exclusionMs）を集計する読み取り専用スクリプト。
 *   npx tsx scripts/cross-level-report.ts <chart.json> [exclusionMs]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/cross-level-report.ts <chart.json> [exclusionMs]');
  process.exit(1);
}
const exclusion = Number(process.argv[3] ?? 80);
const chart = JSON.parse(readFileSync(file, 'utf8')) as { levels: Record<string, { notes: { hitAtMs: number }[] }> };
const keys = ['1', '2', '3', '4'];
const times = Object.fromEntries(keys.map((k) => [k, (chart.levels[k]?.notes ?? []).map((n) => n.hitAtMs).sort((a, b) => a - b)]));
console.log('notes:', keys.map((k) => `L${k}=${times[k]!.length}`).join(' '));
let total = 0;
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const a = times[keys[i]!]!;
    const b = times[keys[j]!]!;
    let count = 0;
    let bi = 0;
    for (const t of a) {
      while (bi < b.length && b[bi]! < t - exclusion) bi++;
      for (let k = bi; k < b.length && b[k]! <= t + exclusion; k++) count++;
    }
    total += count;
    console.log(`L${keys[i]}-L${keys[j]}: ${count} pairs within ${exclusion}ms`);
  }
}
console.log('total pairs:', total);
