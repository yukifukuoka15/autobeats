import { LEVEL_KEYS, formatTimecode } from '@autobeats/chart-format';
import { controller } from '../controller';
import { editorStore, useDocument, useEditorState } from '../store/editorStore';
import { clampScroll } from '../timeline/geometry';

export function StatusBar() {
  const doc = useDocument();
  const view = useEditorState((s) => s.view);
  const analysis = useEditorState((s) => s.analysis);
  const status = useEditorState((s) => s.status);
  const scrub = useEditorState((s) => s.scrub);
  const dur = doc.audio?.durationMs ?? 0;
  const running = analysis.status === 'running' || analysis.status === 'decoding';
  return (
    <footer className="statusbar" data-testid="statusbar">
      <div className="zoom">
        <button className="tiny" onClick={() => controller.zoom(1 / 1.25)} title="縮小（-）">
          −
        </button>
        <input type="range" min={0} max={100} value={Math.round((Math.log(view.zoomPxPerSec / 4) / Math.log(1000)) * 100)} onChange={(e) => editorStore.setView({ zoomPxPerSec: 4 * Math.pow(1000, Number(e.target.value) / 100) })} />
        <button className="tiny" onClick={() => controller.zoom(1.25)} title="拡大（+）">
          +
        </button>
        <span className="dim">{view.zoomPxPerSec.toFixed(0)} px/s</span>
      </div>
      <input
        className="scroll"
        type="range"
        min={0}
        max={Math.max(1, dur)}
        value={Math.min(dur, view.scrollMs)}
        onChange={(e) => editorStore.setView({ scrollMs: clampScroll(Number(e.target.value), view.zoomPxPerSec, dur, 1000) })}
        disabled={dur === 0}
        data-testid="scrollbar"
      />
      <div className="progress" data-testid="analysis-progress" data-status={analysis.status}>
        {running ? (
          <>
            <progress value={analysis.ratio} max={1} />
            <span>
              {analysis.message} {Math.round(analysis.ratio * 100)}%
            </span>
          </>
        ) : (
          <span className="dim">{analysis.message}</span>
        )}
      </div>
      <div className={`status ${status?.kind ?? ''}`} data-testid="status-text">
        {scrub.holding ? (
          <span data-testid="scrub-status">{scrub.direction < 0 ? '逆方向スクラブ中' : 'スクラブ中'}：{formatTimecode(scrub.timeMs)}</span>
        ) : (
          status?.text ?? ''
        )}
      </div>
      <div className="counts" data-testid="note-counts">
        {LEVEL_KEYS.map((k) => (
          <span key={k} data-testid={`count-${k}`}>
            L{k}: {doc.levels[k].notes.length}
          </span>
        ))}
      </div>
    </footer>
  );
}
