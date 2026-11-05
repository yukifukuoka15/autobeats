import { useCallback, useEffect, useState } from 'react';
import { JUDGE, formatTimecode, type LevelNumber } from '@autobeats/chart-format';
import type { DeviceInfo, GameSettings, ImportResult, LibraryEntrySummary, RankingRow } from '../../../shared/types';
import { api } from '../api';

interface Props {
  settings: GameSettings;
  library: LibraryEntrySummary[];
  onSettings: (patch: Partial<GameSettings>) => Promise<void>;
  onReload: () => Promise<void>;
}

export function AdminScreen({ settings, library, onSettings, onReload }: Props) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [message, setMessage] = useState<{ kind: 'info' | 'error' | 'warn'; text: string } | null>(null);
  const [conflict, setConflict] = useState<Extract<ImportResult, { status: 'conflict' }> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LibraryEntrySummary | null>(null);
  const [rankingKey, setRankingKey] = useState<string>('');
  const [rankingKeys, setRankingKeys] = useState<string[]>([]);
  const [rows, setRows] = useState<RankingRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.devices.list().then(setDevices);
  }, []);

  const loadRankingKeys = useCallback(async () => {
    const keys = await api.rankings.keys();
    setRankingKeys(keys);
    if (!rankingKey && keys.length > 0) setRankingKey(keys[0]!);
  }, [rankingKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRankingKeys();
  }, [loadRankingKeys]);

  useEffect(() => {
    void (rankingKey ? api.rankings.get(rankingKey) : Promise.resolve([])).then(setRows);
  }, [rankingKey]);

  const handleImportResult = useCallback(
    async (r: ImportResult) => {
      if (r.status === 'imported') {
        setMessage({ kind: 'info', text: `「${r.entry.title}」(${r.entry.trackId}) を取り込みました。${r.warnings.length ? ' 警告: ' + r.warnings.join(' / ') : ''}` });
        await onReload();
      } else if (r.status === 'duplicate') {
        setMessage({ kind: 'warn', text: `同じ trackId と同じ音声ハッシュの楽曲「${r.entry.title}」はすでに登録されています。` });
      } else if (r.status === 'conflict') {
        setConflict(r);
      } else if (r.status === 'rejected') {
        setMessage({ kind: 'error', text: `取り込めません: ${r.errors.join(' / ')}` });
      }
    },
    [onReload],
  );

  const doImport = async (kind: 'folder' | 'file') => {
    setBusy(true);
    try {
      await handleImportResult(await api.library.import(kind));
    } finally {
      setBusy(false);
    }
  };

  const resolveConflict = async (resolution: 'replace' | 'new-id') => {
    if (!conflict) return;
    const r = await api.library.resolveConflict(conflict.pendingId, resolution);
    setConflict(null);
    await handleImportResult(r);
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    const r = await api.library.delete(confirmDelete.trackId, confirmDelete.audioSha256);
    setConfirmDelete(null);
    if (!r.ok) setMessage({ kind: 'error', text: r.reason ?? '削除できませんでした。' });
    else setMessage({ kind: 'info', text: '楽曲を削除しました。' });
    await onReload();
    await loadRankingKeys();
  };

  const selectTrack = (e: LibraryEntrySummary) => onSettings({ selectedTrackId: e.trackId, selectedAudioSha256: e.audioSha256, mode: 'song' });

  return (
    <div className="grid">
      <section className="card">
        <h2>インポート済み楽曲</h2>
        <div className="row">
          <button data-testid="import-folder" disabled={busy} onClick={() => void doImport('folder')}>
            フォルダから取り込む
          </button>
          <button data-testid="import-file" disabled={busy} onClick={() => void doImport('file')}>
            chart.json を選択して取り込む
          </button>
        </div>
        {message && (
          <div data-testid="admin-message" className={`msg ${message.kind}`}>
            {message.text}
          </div>
        )}
        <table data-testid="library-table">
          <thead>
            <tr>
              <th></th>
              <th>曲名</th>
              <th>ID</th>
              <th>長さ</th>
              <th>BPM</th>
              <th>L1</th>
              <th>L2</th>
              <th>L3</th>
              <th>L4</th>
              <th>検証</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {library.length === 0 && (
              <tr>
                <td colSpan={11} className="muted">
                  楽曲がありません。エディターで書き出したフォルダを取り込んでください。
                </td>
              </tr>
            )}
            {library.map((e) => {
              const selected = settings.selectedTrackId === e.trackId && settings.selectedAudioSha256 === e.audioSha256;
              return (
                <tr key={`${e.trackId}-${e.audioSha256}`} className={selected ? 'selected' : ''} data-testid={`track-${e.trackId}`}>
                  <td>
                    <button data-testid={`select-${e.trackId}`} onClick={() => void selectTrack(e)} disabled={!e.verified.ok}>
                      {selected ? '選択中' : '選択'}
                    </button>
                  </td>
                  <td>{e.title}</td>
                  <td className="muted">{e.trackId}</td>
                  <td>{formatTimecode(e.durationMs, false)}</td>
                  <td>{e.bpm.toFixed(1)}</td>
                  <td>{e.noteCounts['1']}</td>
                  <td>{e.noteCounts['2']}</td>
                  <td>{e.noteCounts['3']}</td>
                  <td>{e.noteCounts['4']}</td>
                  <td className={e.verified.ok ? 'ok' : 'ng'} title={e.verified.errors.join('\n') || e.audioSha256}>
                    {e.verified.ok ? 'OK' : 'NG'} <span className="muted">{e.audioSha256.slice(0, 8)}</span>
                  </td>
                  <td>
                    <button className="danger" data-testid={`delete-${e.trackId}`} onClick={() => setConfirmDelete(e)}>
                      削除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>ゲーム設定</h2>
        <div className="row">
          <label>モード</label>
          <select data-testid="mode-select" value={settings.mode} onChange={(ev) => void onSettings({ mode: ev.target.value as GameSettings['mode'] })}>
            <option value="song">楽曲譜面モード</option>
            <option value="fixed">固定譜面モード</option>
          </select>
        </div>
        <div className="row">
          <label>レベル</label>
          <select data-testid="level-select" value={settings.level} onChange={(ev) => void onSettings({ level: Number(ev.target.value) as LevelNumber })}>
            {[1, 2, 3, 4].map((l) => (
              <option key={l} value={l}>
                LEVEL {l}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>実物ボタン</label>
          <select data-testid="device-select" value={settings.deviceId} onChange={(ev) => void onSettings({ deviceId: ev.target.value })}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>入力遅延補正</label>
          <input
            data-testid="offset-input"
            type="number"
            min={JUDGE.inputOffset.minMs}
            max={JUDGE.inputOffset.maxMs}
            step={JUDGE.inputOffset.stepMs}
            value={settings.inputOffsetMs}
            onChange={(ev) => void onSettings({ inputOffsetMs: Number(ev.target.value) })}
          />
          <span className="muted">ms（補正後押下時刻 = 受信時刻 − 補正値）</span>
        </div>
        <div className="row">
          <label>音楽音量</label>
          <input type="range" min={0} max={1} step={0.05} value={settings.musicVolume} onChange={(ev) => void onSettings({ musicVolume: Number(ev.target.value) })} />
          <span className="muted">{Math.round(settings.musicVolume * 100)}%</span>
        </div>
        <div className="row">
          <label>効果音音量</label>
          <input type="range" min={0} max={1} step={0.05} value={settings.sfxVolume} onChange={(ev) => void onSettings({ sfxVolume: Number(ev.target.value) })} />
          <span className="muted">{Math.round(settings.sfxVolume * 100)}%</span>
        </div>
        <p className="muted">仮想ボタンは Space / J / F キーで押せます。</p>

        <h2 style={{ marginTop: 18 }}>ランキング</h2>
        <div className="row">
          <select data-testid="ranking-key" value={rankingKey} onChange={(ev) => setRankingKey(ev.target.value)}>
            {rankingKeys.length === 0 && <option value="">（記録なし）</option>}
            {rankingKeys.map((k) => (
              <option key={k} value={k}>
                {describeKey(k, library)}
              </option>
            ))}
          </select>
          <button onClick={() => void api.rankings.backup().then((r) => setMessage({ kind: 'info', text: r.ok ? 'ランキングをバックアップしました。' : 'バックアップ対象がありません。' }))}>
            バックアップ
          </button>
        </div>
        <table data-testid="ranking-table">
          <thead>
            <tr>
              <th>順位</th>
              <th>名前</th>
              <th>スコア</th>
              <th>最大コンボ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.rank}</td>
                <td>{r.name || '（無名）'}</td>
                <td>{r.score}</td>
                <td>{r.maxCombo}</td>
                <td>
                  <button
                    onClick={() => {
                      const name = window.prompt('名前を編集', r.name);
                      if (name !== null) void api.rankings.rename(rankingKey, r.id, name).then(() => api.rankings.get(rankingKey)).then(setRows);
                    }}
                  >
                    編集
                  </button>{' '}
                  <button
                    className="danger"
                    onClick={() => {
                      if (window.confirm('この記録を削除しますか？（削除前にバックアップを作成します）')) {
                        void api.rankings.delete(rankingKey, r.id).then(() => api.rankings.get(rankingKey)).then(setRows);
                      }
                    }}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {conflict && (
        <div className="modal-backdrop">
          <div className="modal" data-testid="conflict-dialog">
            <h3>同じ ID の楽曲が登録されています</h3>
            <p>
              既存: 「{conflict.existing.title}」({conflict.existing.trackId}) ハッシュ {conflict.existing.audioSha256.slice(0, 8)}
              <br />
              取り込み: 「{conflict.incoming.title}」 ハッシュ {conflict.incoming.audioSha256.slice(0, 8)}
            </p>
            <p className="muted">置換すると既存のランキングとは別キーになります（ハッシュが異なるため）。</p>
            <div className="row">
              <button data-testid="conflict-replace" className="primary" onClick={() => void resolveConflict('replace')}>
                置換する
              </button>
              <button data-testid="conflict-new-id" onClick={() => void resolveConflict('new-id')}>
                別IDで登録する
              </button>
              <button
                onClick={() => {
                  void api.library.cancelConflict(conflict.pendingId);
                  setConflict(null);
                }}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete && (
        <div className="modal-backdrop">
          <div className="modal" data-testid="delete-dialog">
            <h3>楽曲を削除しますか？</h3>
            <p>
              「{confirmDelete.title}」({confirmDelete.trackId}) の音声と譜面をライブラリから削除します。ランキング記録は残ります。
            </p>
            <div className="row">
              <button data-testid="delete-confirm" className="danger" onClick={() => void doDelete()}>
                削除する
              </button>
              <button onClick={() => setConfirmDelete(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function describeKey(key: string, library: LibraryEntrySummary[]): string {
  const m = /^([^:]+):song:([^:]+):([0-9a-f]{64}):v(\d+):L([1-4])$/.exec(key);
  if (!m) return key.includes(':fixed:') ? '固定譜面' : key;
  const entry = library.find((e) => e.trackId === m[2] && e.audioSha256 === m[3]);
  return `${entry?.title ?? m[2]} / LEVEL ${m[5]} (${m[3]!.slice(0, 6)})`;
}
