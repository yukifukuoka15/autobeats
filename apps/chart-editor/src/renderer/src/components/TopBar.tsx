import { useState } from 'react';
import { controller } from '../controller';
import { editorStore, useDocument, useEditorState } from '../store/editorStore';

export function TopBar() {
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const doc = useDocument();
  const importUrl = async (text: string) => {
    if (importing || !text.trim()) return;
    setImporting(true);
    try { await controller.importYoutube(text); }
    finally { setImporting(false); }
  };
  const projectName = useEditorState((s) => s.projectName);
  const dirty = useEditorState((s) => s.history.index !== s.history.savedIndex);
  const analysis = useEditorState((s) => s.analysis);
  const running = analysis.status === 'running' || analysis.status === 'decoding';
  return (
    <>
    <div className="youtube-import" inert={importing || undefined}>
      <label htmlFor="youtube-url">YouTube</label>
      <input id="youtube-url" data-testid="youtube-url" type="text" value={url} placeholder="YouTubeリンクを貼り付けると自動で読み込みます"
        onChange={(event) => setUrl(event.target.value)}
        onPaste={(event) => { const text = event.clipboardData.getData('text'); if (/https?:\/\//.test(text)) { event.preventDefault(); setUrl(text); void importUrl(text); } }}
        onKeyDown={(event) => { if (event.key === 'Enter') void importUrl(url); }} />
      <button disabled={!url.trim() || importing} onClick={() => void importUrl(url)}>読み込む</button>
    </div>
    {importing && <div role="status" className="youtube-import">YouTube の音声を取得・変換しています…</div>}
    <div inert={importing || undefined}>
    <header className="topbar">
      <div className="topbar-left">
        <span className="app-name">AutoBeats</span>
        <span className="project-name" data-testid="project-name">
          {projectName ?? '無題のプロジェクト'}
        </span>
        <span className={`dirty ${dirty ? 'is-dirty' : ''}`} data-testid="dirty-indicator" title={dirty ? '未保存の変更があります' : '保存済み'}>
          {dirty ? '● 未保存' : '保存済み'}
        </span>
      </div>
      <div className="topbar-right">
        <button data-testid="btn-open-audio" onClick={() => void controller.openAudio()}>
          楽曲を読み込む…
        </button>
        <button data-testid="btn-analyze" className="accent" disabled={!doc.audio || running} onClick={() => void controller.analyze()} title="ローカル音響解析（精度は音源により変わります）">
          {running ? '解析中…' : 'AI自動解析'}
        </button>
        {running && (
          <button data-testid="btn-cancel-analysis" onClick={() => controller.cancelAnalysis()}>
            キャンセル
          </button>
        )}
        <button data-testid="btn-save" onClick={() => void controller.save(false)}>
          保存
        </button>
        <button data-testid="btn-playtest" disabled={!doc.audio} onClick={() => controller.openPlaytest()} title="Q / W / O / P で 4 レーンを同時に試奏（Cmd+P）">
          プレイテスト
        </button>
        <button data-testid="btn-export" disabled={!doc.audio} onClick={() => void controller.exportPackage()}>
          ゲーム用に書き出し…
        </button>
        <button data-testid="btn-undo" disabled={!useEditorStoreCanUndo()} onClick={() => editorStore.undo()} title={editorStore.undoLabel ?? ''}>
          ↶
        </button>
        <button data-testid="btn-redo" disabled={!useEditorStoreCanRedo()} onClick={() => editorStore.redo()} title={editorStore.redoLabel ?? ''}>
          ↷
        </button>
      </div>
    </header>
    </div>
    </>
  );
}

function useEditorStoreCanUndo(): boolean {
  return useEditorState((s) => s.history.index > 0);
}
function useEditorStoreCanRedo(): boolean {
  return useEditorState((s) => s.history.index < s.history.entries.length - 1);
}
