import { verifyChartPackage } from '@autobeats/chart-format';
import { nodePackageFs, sha256File } from '@autobeats/chart-format/node';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { exportGamePackage } from '../../src/main/services/exportPackage';
import { buildProjectFile, projectToDocument, readProjectFile, writeProjectFile } from '../../src/main/services/project';
import * as cmd from '../../src/renderer/src/store/document';

it('異なる難易度の同時刻・80ms近接ノーツを保存・再読込・パッケージ書き出しで保持する', async () => {
  const fixture = path.resolve(__dirname, '../../../../fixtures/generated/song.wav');
  const dir = await mkdtemp(path.join(tmpdir(), 'autobeats-overlap-'));
  try {
    const doc = cmd.documentWithAudio(cmd.createEmptyDocument(), {
      token: 't'.repeat(32), fileName: 'song.wav', extension: '.wav', sizeBytes: (await stat(fixture)).size,
      mtimeMs: 0, sha256: await sha256File(fixture), displayPath: fixture, durationMs: 60000, sampleRate: 22050, channels: 1,
    });
    doc.levels['1'].notes = [{ id: 'a', hitAtMs: 1000, source: 'manual' }];
    doc.levels['2'].notes = [{ id: 'b', hitAtMs: 1000, source: 'manual' }];
    doc.levels['3'].notes = [{ id: 'c', hitAtMs: 1080, source: 'manual' }];
    const projectPath = path.join(dir, 'song.rhythm-project.json');
    await writeProjectFile(projectPath, buildProjectFile({ document: doc, audioPath: fixture, view: null }));
    const reloaded = projectToDocument(await readProjectFile(projectPath), 't'.repeat(32), fixture);
    expect(reloaded.levels).toEqual(doc.levels);
    const r = await exportGamePackage(reloaded, fixture, path.join(dir, 'export'), 'ask');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const verified = await verifyChartPackage(r.dir, nodePackageFs);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.pkg.chart.levels['2'].notes[0]?.hitAtMs).toBe(1000);
      expect(verified.pkg.chart.levels['3'].notes[0]?.hitAtMs).toBe(1080);
      expect(verified.pkg.chart.generationRules?.crossLevelNotesAreExclusive).toBe(false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
