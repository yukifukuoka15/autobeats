import { CROSS_LEVEL_EXCLUSION_MS, MASH, formatTimecode, type LevelKey } from '@autobeats/chart-format';
import { useMemo } from 'react';
import { controller } from '../controller';
import { findNoteIssues, summarizeIssues, type NoteIssue } from '../store/document';
import { editorStore, useDocument, useEditorState } from '../store/editorStore';

export function RightPanel() {
  const doc = useDocument();
  const selection = useEditorState((s) => s.selection);
  const view = useEditorState((s) => s.view);
  const issues = useMemo(() => findNoteIssues(doc), [doc]);
  return (
    <aside className="panel right-panel" data-testid="right-panel">
      <section>
        <h3>スナップ</h3>
        <label className="inline">
          <input type="checkbox" data-testid="snap-enabled" checked={view.snapEnabled} onChange={(e) => editorStore.setView({ snapEnabled: e.target.checked })} /> スナップ有効（Option でドラッグ中だけ解除）
        </label>
        <select data-testid="snap-target" value={view.snapTarget} onChange={(e) => editorStore.setView({ snapTarget: e.target.value as typeof view.snapTarget })}>
          <option value="beat">拍</option>
          <option value="half">半拍</option>
          <option value="quarter">4分割</option>
          <option value="onset">オンセット候補</option>
        </select>
      </section>
      <section>
        <h3>選択中</h3>
        {!selection && <p className="hint">タイムライン上のヒットまたはサビ区間をクリックすると詳細を編集できます。レーンをダブルクリックまたは J でヒットを追加、F を押している間が連打になります。</p>}
        {selection?.kind === 'notes' && <NoteDetails level={selection.level} ids={selection.ids} />}
        {selection?.kind === 'chorus' && <ChorusDetails id={selection.id} />}
      </section>
      <ValidationSection issues={issues} />
    </aside>
  );
}

const PAIR_KEYS = ['1-2', '1-3', '1-4', '2-3', '2-4', '3-4'] as const;

function ValidationSection({ issues }: { issues: NoteIssue[] }) {
  const summary = useMemo(() => summarizeIssues(issues), [issues]);
  const readOnly = useEditorState((s) => s.readOnly);
  const generationWarnings = useEditorState((s) => s.generationWarnings);
  const jump = (i: NoteIssue) => controller.jumpToIssue(i.level, i.id, i.hitAtMs);
  return (
    <section data-testid="validation">
      <h3>検証（リアルタイム）</h3>
      {readOnly && (
        <p className="hint warn" data-testid="read-only-banner">
          読み取り専用で確認中（編集は拒否されます）。
          <button className="small" data-testid="btn-leave-readonly" onClick={() => editorStore.setReadOnly(false)}>
            解除
          </button>
        </p>
      )}
      {generationWarnings.length > 0 && (
        <ul className="issues" data-testid="generation-warnings">
          {generationWarnings.map((w, i) => (
            <li key={i} className="warn">
              {w.split('\n').map((line, j) => (
                <div key={j}>{line}</div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {summary.total === 0 ? (
        <p className="hint ok" data-testid="issues-none">
          検証OK
          <br />
          同一レベル内の衝突、難易度間の{CROSS_LEVEL_EXCLUSION_MS}ms以内の衝突、
          <br />
          範囲外、最小間隔違反はありません。
        </p>
      ) : (
        <div data-testid="issues-summary">
          <ul className="issues summary">
            {summary.byCode['cross-level'] > 0 && (
              <li className="error" data-testid="issues-cross-level">
                難易度間の衝突: {summary.byCode['cross-level']}件
                <ul>
                  {PAIR_KEYS.map((k) => (
                    <li key={k} data-testid={`issues-pair-${k}`}>
                      L{k.replace('-', '–L')}: {summary.crossLevelByPair[k] ?? 0}件
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {summary.byCode.collision > 0 && <li className="error">同一レベル内の完全重複: {summary.byCode.collision}件</li>}
            {summary.byCode['min-gap'] > 0 && <li className="warn">同一レベル内の最小間隔違反: {summary.byCode['min-gap']}件</li>}
            {summary.byCode.range > 0 && <li className="error">範囲外（0ms未満・曲の長さ以後）: {summary.byCode.range}件</li>}
            {summary.byCode['bad-id'] > 0 && <li className="error">不正なID: {summary.byCode['bad-id']}件</li>}
            {summary.byCode['non-integer'] > 0 && <li className="error">非整数の hitAtMs: {summary.byCode['non-integer']}件</li>}
          </ul>
          {summary.byCode['cross-level'] > 0 && (
            <div className="row">
              <button className="small accent" data-testid="btn-repair-conflicts" onClick={() => controller.repairConflicts()}>
                衝突しているヒットだけ修復
              </button>
              <button className="small" data-testid="btn-regen-conflicts" onClick={() => editorStore.setDialog({ kind: 'regenerate', reason: 'settings' })}>
                4レベルを再生成
              </button>
            </div>
          )}
          <ul className="issues" data-testid="issues-list">
            {issues.slice(0, 50).map((i, idx) => (
              <li key={idx} className={i.code === 'min-gap' ? 'warn' : 'error'}>
                <button className="link" data-testid="issue-jump" onClick={() => jump(i)}>
                  {i.message}
                </button>
              </li>
            ))}
            {issues.length > 50 && <li>…他 {issues.length - 50} 件</li>}
          </ul>
        </div>
      )}
    </section>
  );
}

function NoteDetails({ level, ids }: { level: LevelKey; ids: ReadonlySet<string> }) {
  const doc = useDocument();
  const notes = doc.levels[level].notes.filter((n) => ids.has(n.id));
  if (notes.length === 0) return null;
  const single = notes.length === 1 ? notes[0]! : null;
  return (
    <div data-testid="note-details">
      <dl className="kv">
        <dt>レベル</dt>
        <dd>L{level}</dd>
        <dt>選択数</dt>
        <dd data-testid="selected-count">{notes.length}</dd>
        {single && (
          <>
            <dt>ID</dt>
            <dd className="mono">{single.id}</dd>
            <dt>種類</dt>
            <dd data-testid="note-type">{single.type === 'mash' ? `連打（${single.durationMs ?? 0}ms）` : 'ヒット'}</dd>
            <dt>入力</dt>
            <dd>{single.source === 'manual' ? '手作業' : '自動生成'}</dd>
            <dt>生成理由</dt>
            <dd data-testid="note-reason">{single.reason ?? '-'}</dd>
            <dt>時刻</dt>
            <dd>
              {formatTimecode(single.hitAtMs)}
              {single.type === 'mash' && single.durationMs ? ` 〜 ${formatTimecode(single.hitAtMs + single.durationMs)}` : ''}
            </dd>
          </>
        )}
      </dl>
      {single && (
        <div className="row">
          <button className="small" data-testid="btn-toggle-mash" onClick={() => editorStore.setNoteType(level, single.id, single.type === 'mash' ? 'tap' : 'mash')}>
            {single.type === 'mash' ? '通常ヒットにする' : '連打にする'}
          </button>
        </div>
      )}
      {single && single.type === 'mash' && (
        <label>
          連打の長さ (ms、{MASH.minDurationMs} 以上)
          <input
            type="number"
            data-testid="input-mash-duration"
            key={single.id + (single.durationMs ?? 0)}
            defaultValue={single.durationMs ?? 0}
            min={MASH.minDurationMs}
            step={10}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v) && v !== single.durationMs) {
                if (!editorStore.setNoteDuration(level, single.id, v)) e.target.value = String(single.durationMs ?? 0);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
      )}
      {single && (
        <label>
          hitAtMs（整数ミリ秒）
          <input
            type="number"
            data-testid="input-hit-at"
            key={single.id + single.hitAtMs}
            defaultValue={single.hitAtMs}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v) && v !== single.hitAtMs) {
                // 共通判定で拒否されたら入力欄を元の値へ戻す
                if (!editorStore.setNoteTime(level, single.id, v)) e.target.value = String(single.hitAtMs);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        </label>
      )}
      <div className="row">
        <button className="small" onClick={() => editorStore.moveSelectedNotes(-10)}>
          −10ms
        </button>
        <button className="small" onClick={() => editorStore.moveSelectedNotes(-1)}>
          −1ms
        </button>
        <button className="small" onClick={() => editorStore.moveSelectedNotes(1)}>
          +1ms
        </button>
        <button className="small" onClick={() => editorStore.moveSelectedNotes(10)}>
          +10ms
        </button>
      </div>
      <button className="small danger" data-testid="btn-delete-selection" onClick={() => editorStore.deleteSelection()}>
        選択したヒットを削除
      </button>
      {single && (
        <button className="small" onClick={() => controller.seek(single.hitAtMs)}>
          この位置へシーク
        </button>
      )}
    </div>
  );
}

function ChorusDetails({ id }: { id: string }) {
  const doc = useDocument();
  const c = doc.choruses.find((x) => x.id === id);
  if (!c) return null;
  return (
    <div data-testid="chorus-details">
      <dl className="kv">
        <dt>ID</dt>
        <dd className="mono">{c.id}</dd>
        <dt>種別</dt>
        <dd>{c.source === 'detected' ? `自動検出（信頼度 ${Math.round(c.confidence * 100)}%）` : '手動'}</dd>
        <dt>長さ</dt>
        <dd>{formatTimecode(c.endMs - c.startMs)}</dd>
      </dl>
      <label>
        開始 (ms)
        <input type="number" data-testid="input-chorus-start" key={`s${c.id}${c.startMs}`} defaultValue={c.startMs} onBlur={(e) => { const v = Math.round(Number(e.target.value)); if (v !== c.startMs) { editorStore.updateChorus(id, { startMs: v }); controller.afterChorusEdit(); } }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label>
        終了 (ms)
        <input type="number" data-testid="input-chorus-end" key={`e${c.id}${c.endMs}`} defaultValue={c.endMs} onBlur={(e) => { const v = Math.round(Number(e.target.value)); if (v !== c.endMs) { editorStore.updateChorus(id, { endMs: v }); controller.afterChorusEdit(); } }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </label>
      <button className="small danger" data-testid="btn-delete-chorus" onClick={() => { editorStore.deleteSelection(); controller.afterChorusEdit(); }}>
        サビ区間を削除
      </button>
      <button className="small" onClick={() => controller.setLoopRange(c.startMs, c.endMs)}>
        この区間をループ範囲にする
      </button>
    </div>
  );
}
