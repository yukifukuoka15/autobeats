import { CROSS_LEVEL_EXCLUSION_MS } from '@autobeats/chart-format';
import { controller } from '../controller';
import { editorStore, useDocument, useEditorState } from '../store/editorStore';

export function Dialogs() {
  const doc = useDocument();
  const dialog = useEditorState((s) => s.dialog);
  const additive = doc.noteMode === 'additive' || (dialog.kind === 'regenerate' && dialog.easy);
  const view = useEditorState((s) => s.view);
  if (dialog.kind === 'none') return null;
  const close = () => editorStore.setDialog({ kind: 'none' });
  return (
    <div className="modal-backdrop" data-testid={`dialog-${dialog.kind}`}>
      <div className="modal" role="dialog">
        {dialog.kind === 'regenerate' && (
          <>
            <h2>{dialog.easy ? 'やさしい追加譜面に作り直しますか？' : '譜面を再生成しますか？'}</h2>
            <p>
              {dialog.reason === 'chorus' ? 'サビ区間が変更されました。' : dialog.reason === 'analysis' ? '解析結果を適用しました。' : '設定に基づいて'}
              再生成は 1 回の操作として Undo できます。
            </p>
            <label className="inline">
              <input type="checkbox" id="keep-manual" defaultChecked /> 手作業で追加・移動したヒット（連打を含む）を残す（オフにすると置き換えます）
            </label>
            {additive && <label className="inline"><input id="regen-base" type="checkbox" defaultChecked={!!dialog.easy} /> Lv1の自動生成分も作り直す（手作業ヒットの保持設定に従う）</label>}
            <div className="actions">
              <button data-testid="regen-all" className="accent" onClick={() => { close(); controller.regenerate(additive ? ['2', '3'] : ['1', '2', '3'], keepManual() ? 'keep' : 'replace', { easy: dialog.easy, regenerateBase: (document.getElementById('regen-base') as HTMLInputElement | null)?.checked ?? false }); }}>
                {dialog.easy ? 'やさしく作り直す' : additive ? '追加分を生成（空のLv1は自動作成）' : '3難易度を再生成'}
              </button>
              <button data-testid="regen-active" disabled={additive && view.activeLevel === '1' && doc.levels['1'].notes.length > 0} onClick={() => { close(); controller.regenerate([view.activeLevel], keepManual() ? 'keep' : 'replace', { easy: dialog.easy, regenerateBase: (document.getElementById('regen-base') as HTMLInputElement | null)?.checked ?? false }); }}>
                選択レベル（L{view.activeLevel}）だけ再生成
              </button>
              <button data-testid="regen-keep" onClick={close}>
                既存ヒットを維持
              </button>
            </div>
          </>
        )}
        {dialog.kind === 'conflicts' && (
          <>
            <h2 className="error">難易度間の衝突があります</h2>
            <p>
              {dialog.source} には、異なるレベル間で {CROSS_LEVEL_EXCLUSION_MS}ms 以内に並ぶヒットが {dialog.total} 組あります。自動では削除していません。
            </p>
            <ul className="issues summary" data-testid="conflicts-by-pair">
              {(Object.entries(dialog.byPair) as [string, number][]).map(([k, n]) => (
                <li key={k}>
                  L{k.replace('-', '–L')}: {n}件
                </li>
              ))}
            </ul>
            <div className="actions">
              <button data-testid="conflicts-regen" className="accent" onClick={() => editorStore.setDialog({ kind: 'regenerate', reason: 'settings' })}>
                4レベルを再生成する
              </button>
              <button data-testid="conflicts-repair" onClick={() => { close(); controller.repairConflicts(); }}>
                衝突しているヒットだけ修復する
              </button>
              <button data-testid="conflicts-readonly" onClick={() => { editorStore.setReadOnly(true); close(); }}>
                読み取り専用で確認する
              </button>
              <button data-testid="conflicts-cancel" onClick={close}>
                キャンセル
              </button>
            </div>
          </>
        )}
        {dialog.kind === 'overlap' && (
          <>
            <h2>サビ区間が重なっています</h2>
            <p>重なるサビ区間は保存・書き出し前に結合する必要があります。結合しますか？</p>
            <div className="actions">
              <button data-testid="overlap-merge" className="accent" onClick={() => { editorStore.mergeOverlaps(); close(); }}>
                結合する
              </button>
              <button onClick={close}>キャンセル（手動で修正）</button>
            </div>
          </>
        )}
        {dialog.kind === 'export-exists' && (
          <>
            <h2>書き出し先に同名フォルダがあります</h2>
            <p>{dialog.displayPath}</p>
            <div className="actions">
              <button data-testid="export-overwrite" onClick={() => { close(); void controller.exportPackage({ requestId: dialog.requestId, mode: 'overwrite' }); }}>
                上書き
              </button>
              <button data-testid="export-rename" className="accent" onClick={() => { close(); void controller.exportPackage({ requestId: dialog.requestId, mode: 'rename' }); }}>
                別名で保存
              </button>
              <button onClick={close}>キャンセル</button>
            </div>
          </>
        )}
        {(dialog.kind === 'export-result' || dialog.kind === 'message') && (
          <>
            <h2 className={dialog.kind === 'export-result' && !dialog.ok ? 'error' : ''}>{dialog.title}</h2>
            <div className="lines" data-testid="dialog-lines">
              {dialog.lines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
            <div className="actions">
              <button className="accent" data-testid="dialog-ok" onClick={close}>
                OK
              </button>
            </div>
          </>
        )}
        {dialog.kind === 'verify-result' && (
          <>
            <h2 className={dialog.ok ? '' : 'error'}>{dialog.ok ? '書き出しフォルダの検証結果' : '検証に失敗しました'}</h2>
            <p className="dim">{dialog.displayPath}</p>
            <div className="lines" data-testid="dialog-lines">
              {dialog.lines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
            <div className="actions">
              {dialog.canImport && dialog.chart && (
                <button data-testid="verify-import" onClick={() => controller.importVerifiedChart(dialog.chart!)}>
                  この譜面を現在のプロジェクトへ読み込む
                </button>
              )}
              <button className="accent" data-testid="dialog-ok" onClick={close}>
                OK
              </button>
            </div>
          </>
        )}
        {dialog.kind === 'recovery' && (
          <>
            <h2>復旧データがあります</h2>
            <p>前回のセッションの自動保存データが見つかりました。復旧すると元のプロジェクトは上書きされず、未保存の状態で開きます。</p>
            <ul className="recovery-list">
              {dialog.entries.map((e) => (
                <li key={e.id} data-testid="recovery-entry">
                  <div>
                    <strong>{e.originalName}</strong>
                    <span className="dim"> {e.originalDisplayPath}</span>
                    <div className="dim">{new Date(e.savedAt).toLocaleString('ja-JP')}</div>
                  </div>
                  <div>
                    <button className="small accent" data-testid="recovery-open" onClick={() => void controller.recover(e.id)}>
                      復旧
                    </button>
                    <button className="small" data-testid="recovery-discard" onClick={() => void controller.discardRecovery(e.id)}>
                      破棄
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button onClick={close}>あとで</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function keepManual(): boolean {
  return (document.getElementById('keep-manual') as HTMLInputElement | null)?.checked ?? true;
}
