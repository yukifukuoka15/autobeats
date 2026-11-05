import { LEVEL_KEYS, formatTimecode, type LevelKey } from '@autobeats/chart-format';
import { controller } from '../controller';
import { editorStore, useDocument, useEditorState } from '../store/editorStore';
import { LEVEL_COLORS } from '../timeline/draw';

function fmtBytes(b: number): string {
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b > 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

export function LeftPanel() {
  const doc = useDocument();
  const view = useEditorState((s) => s.view);
  const audio = doc.audio;
  return (
    <aside className="panel left-panel" data-testid="left-panel">
      <LibrarySection currentSha={audio?.sha256 ?? null} />
      <section>
        <h3>楽曲情報</h3>
        {audio ? (
          <dl className="kv" data-testid="audio-info">
            <dt>ファイル</dt>
            <dd title={audio.displayPath}>{audio.fileName}</dd>
            <dt>形式</dt>
            <dd>{audio.extension.replace('.', '').toUpperCase()}</dd>
            <dt>サイズ</dt>
            <dd>{fmtBytes(audio.sizeBytes)}</dd>
            <dt>長さ</dt>
            <dd data-testid="audio-duration">{formatTimecode(audio.durationMs)}</dd>
            <dt>サンプルレート</dt>
            <dd>{audio.sampleRate} Hz</dd>
            <dt>チャンネル</dt>
            <dd>{audio.channels === 1 ? 'モノラル' : audio.channels === 2 ? 'ステレオ' : `${audio.channels}ch`}</dd>
            <dt>SHA-256</dt>
            <dd className="mono" title={audio.sha256}>
              {audio.sha256.slice(0, 12)}…
            </dd>
          </dl>
        ) : (
          <p className="hint">楽曲が読み込まれていません。「楽曲を読み込む…」から MP3 / WAV / M4A / OGG を選択してください。</p>
        )}
        <button className="small" onClick={() => void controller.relocateAudio()} disabled={!audio && !doc.title}>
          音声を指定し直す…
        </button>
      </section>
      <section>
        <h3>プロジェクト</h3>
        <label>
          曲名
          <input data-testid="input-title" value={doc.title} onChange={(e) => editorStore.setMeta({ title: e.target.value })} />
        </label>
        <label>
          アーティスト
          <input value={doc.artist} onChange={(e) => editorStore.setMeta({ artist: e.target.value })} />
        </label>
        <label>
          楽曲ID（英小文字・数字・-・_）
          <input data-testid="input-track-id" value={doc.trackId} onChange={(e) => editorStore.setMeta({ trackId: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64) })} />
        </label>
        <div className="row">
          <label>
            BPM
            <input type="number" step="0.01" min={30} max={300} value={doc.bpm} onChange={(e) => editorStore.setMeta({ bpm: Number(e.target.value) })} />
          </label>
          <label>
            オフセット(ms)
            <input type="number" value={doc.offsetMs} onChange={(e) => editorStore.setMeta({ offsetMs: Math.round(Number(e.target.value)) })} />
          </label>
        </div>
      </section>
      <section>
        <h3>解析設定</h3>
        <p className="hint">「AI自動解析」はローカル音響解析です。精度は音源によって変わるため、結果は必ず試聴して手修正してください。</p>
        {doc.analysis && (
          <dl className="kv" data-testid="analysis-info">
            <dt>推定BPM</dt>
            <dd>
              {doc.analysis.bpm.toFixed(2)}（信頼度 {Math.round(doc.analysis.bpmConfidence * 100)}%）
            </dd>
            <dt>拍</dt>
            <dd>{doc.analysis.beats.length}</dd>
            <dt>オンセット</dt>
            <dd>{doc.analysis.onsets.length}</dd>
            <dt>セクション</dt>
            <dd>{doc.analysis.sections.length}</dd>
            <dt>無音</dt>
            <dd>
              頭 {formatTimecode(doc.analysis.leadInEndMs)} / 末 {formatTimecode(doc.analysis.tailStartMs)}
            </dd>
          </dl>
        )}
        <div className="row">
          <button className="small" disabled={!doc.analysis} onClick={() => editorStore.setDialog({ kind: 'regenerate', reason: 'settings' })}>
            譜面を再生成…
          </button>
        </div>
      </section>
      <section>
        <h3>難易度設定</h3>
        {LEVEL_KEYS.map((k) => (
          <LevelSettings key={k} level={k} active={view.activeLevel === k} />
        ))}
      </section>
    </aside>
  );
}

/** これまでに読み込んだ楽曲と譜面データの一覧（アプリ内ライブラリ） */
function LibrarySection({ currentSha }: { currentSha: string | null }) {
  const library = useEditorState((s) => s.library);
  return (
    <section data-testid="library">
      <h3>ライブラリ（{library.length}）</h3>
      {library.length === 0 ? (
        <p className="hint">楽曲を読み込むと、音声のコピーと譜面データがアプリ内に保存され、ここに一覧されます。</p>
      ) : (
        <ul className="library-list">
          {library.map((e) => (
            <li key={e.id} className={e.sha256 === currentSha ? 'current' : ''} data-testid="library-entry" data-library-id={e.id}>
              <div className="lib-title" title={`${e.fileName}\n元: ${e.originalDisplayPath}`}>
                {e.title || e.fileName}
              </div>
              <div className="lib-meta">
                {e.durationMs > 0 ? formatTimecode(e.durationMs, false) : '--:--'} / BPM {e.bpm > 0 ? e.bpm.toFixed(1) : '-'}
                {e.hasProject ? ` / L1 ${e.noteCounts['1']} L2 ${e.noteCounts['2']} L3 ${e.noteCounts['3']} L4 ${e.noteCounts['4']}` : ' / 譜面なし'}
              </div>
              <div className="lib-meta dim">更新 {new Date(e.updatedAt).toLocaleString('ja-JP')}</div>
              <div className="row">
                <button className="small" data-testid="library-open" onClick={() => void controller.openLibraryEntry(e.id)} disabled={e.sha256 === currentSha}>
                  {e.sha256 === currentSha ? '編集中' : '開く'}
                </button>
                <button className="small danger" data-testid="library-remove" onClick={() => void controller.removeLibraryEntry(e.id)}>
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LevelSettings({ level, active }: { level: LevelKey; active: boolean }) {
  const doc = useDocument();
  const view = useEditorState((s) => s.view);
  const s = doc.levelSettings[level];
  const count = doc.levels[level].notes.length;
  return (
    <details className={`level-settings ${active ? 'active' : ''}`} open={active} data-testid={`level-settings-${level}`}>
      <summary>
        <span className="swatch" style={{ background: LEVEL_COLORS[level] }} />
        <span>L{level}</span>
        <span className="dim">{doc.levels[level].displayName}</span>
        <span className="dim">{count} ヒット</span>
        <label className="inline" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={view.visibleLevels[level]} onChange={(e) => editorStore.setView({ visibleLevels: { ...view.visibleLevels, [level]: e.target.checked } })} /> 表示
        </label>
        <button className="tiny" onClick={(e) => { e.preventDefault(); editorStore.setView({ activeLevel: level }); }} data-testid={`btn-activate-${level}`}>
          編集
        </button>
      </summary>
      <label>
        密度 {s.density.toFixed(2)}
        <input type="range" min={0} max={1} step={0.05} value={s.density} onChange={(e) => editorStore.setLevelSettings(level, { density: Number(e.target.value) })} />
      </label>
      <label>
        最小間隔 (ms)
        <input type="number" min={50} max={5000} step={10} value={s.minGapMs} data-testid={`input-mingap-${level}`} onChange={(e) => editorStore.setLevelSettings(level, { minGapMs: Math.max(1, Math.round(Number(e.target.value))) })} />
      </label>
      <label>
        サビ密度倍率 {s.chorusDensityMultiplier.toFixed(2)}
        <input type="range" min={1} max={3} step={0.05} value={s.chorusDensityMultiplier} onChange={(e) => editorStore.setLevelSettings(level, { chorusDensityMultiplier: Number(e.target.value) })} />
      </label>
      <label>
        拍スナップ強度 {s.beatSnapStrength.toFixed(2)}
        <input type="range" min={0} max={1} step={0.05} value={s.beatSnapStrength} onChange={(e) => editorStore.setLevelSettings(level, { beatSnapStrength: Number(e.target.value) })} />
      </label>
    </details>
  );
}
