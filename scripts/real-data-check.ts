/**
 * 実データ確認: 指定 MP3 をエディター（ビルド済み out/）で読み込み→AI自動解析→譜面JSON書き出し→難易度間衝突を集計する。
 * 原本は読み取りのみ。出力は一時フォルダ。
 *   npx tsx scripts/real-data-check.ts <audio.mp3> [screenshot.png]
 */
import { _electron as electron } from 'playwright';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CROSS_LEVEL_EXCLUSION_MS, DEFAULT_LEVEL_SETTINGS, findCrossLevelConflicts, parseAndValidateChart, serializeChart, type ChartFile } from '../packages/chart-format/src/index';

const audio = process.argv[2];
const shot = process.argv[3];
if (!audio) throw new Error('usage: tsx scripts/real-data-check.ts <audio.mp3> [screenshot.png]');
const MAIN = path.resolve('apps/chart-editor/out/main/index.js');
const work = mkdtempSync(path.join(tmpdir(), 'autobeats-real-'));

const app = await electron.launch({ args: [MAIN], env: { ...process.env, AUTOBEATS_USER_DATA: path.join(work, 'userdata') } });
const page = await app.firstWindow();
await page.waitForSelector('[data-testid="app"]');
await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, audio);
await page.getByTestId('btn-open-audio').click();
await page.getByTestId('audio-duration').waitFor({ timeout: 120000 });
const t0 = Date.now();
await page.getByTestId('btn-analyze').click();
await page.waitForFunction(() => document.querySelector('[data-testid="analysis-progress"]')?.getAttribute('data-status') === 'done', null, { timeout: 300000 });
const analysisMs = Date.now() - t0;
const status = await page.getByTestId('status-text').textContent();
const warnings = await page.getByTestId('generation-warnings').allTextContents().catch(() => []);
const validation = await page.getByTestId('validation').textContent();
const out = path.join(work, 'chart.json');
await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('menu:action', 'exportJson'));
await page.getByTestId('dialog-export-result').waitFor();
const exportText = await page.getByTestId('dialog-export-result').textContent();
await page.getByTestId('dialog-ok').click();
if (shot) {
  await page.getByTestId('timeline-canvas').screenshot({ path: shot });
}
await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
await app.close();

const text = readFileSync(out, 'utf8');
const parsed = parseAndValidateChart(text, { minGapMsByLevel: { '1': DEFAULT_LEVEL_SETTINGS[1].minGapMs, '2': DEFAULT_LEVEL_SETTINGS[2].minGapMs, '3': DEFAULT_LEVEL_SETTINGS[3].minGapMs, '4': DEFAULT_LEVEL_SETTINGS[4].minGapMs }, minGapAsError: true, crossLevelExclusionMs: CROSS_LEVEL_EXCLUSION_MS });
if (!parsed.ok) throw new Error('export invalid: ' + parsed.errors.map((e) => e.message).join('\n'));
const chart: ChartFile = parsed.chart;
const report = findCrossLevelConflicts(chart.levels, CROSS_LEVEL_EXCLUSION_MS);
const roundTrip = parseAndValidateChart(serializeChart(chart));
console.log(JSON.stringify({
  file: path.basename(path.dirname(audio)) + '/' + path.basename(audio),
  durationMs: chart.durationMs,
  bpm: chart.bpm,
  analysisMs,
  notes: { L1: chart.levels['1'].notes.length, L2: chart.levels['2'].notes.length, L3: chart.levels['3'].notes.length, L4: chart.levels['4'].notes.length },
  crossLevelPairs: report.countsByPair,
  crossLevelTotal: report.total,
  outOfRange: Object.values(chart.levels).flatMap((l) => l.notes).filter((n) => n.hitAtMs < 0 || n.hitAtMs >= chart.durationMs).length,
  roundTripIdentical: roundTrip.ok && JSON.stringify(roundTrip.chart) === JSON.stringify(chart),
  generationRules: chart.generationRules,
  statusAfterAnalysis: status,
  generationWarnings: warnings,
  validationPanel: validation?.slice(0, 120),
  exportDialog: exportText?.slice(0, 80),
  exportedTo: out,
}, null, 2));
