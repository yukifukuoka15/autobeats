import { formatTimecode } from '@autobeats/chart-format';
import { controller } from '../controller';
import { editorStore, useDocument, useEditorState, type PlaybackPrefs } from '../store/editorStore';
import { usePlayhead } from '../store/playhead';

const RATES: PlaybackPrefs['rate'][] = [0.5, 0.75, 1, 1.25];

export function TransportBar() {
  const doc = useDocument();
  const { ms, playing } = usePlayhead();
  const playback = useEditorState((s) => s.playback);
  const loop = useEditorState((s) => s.loop);
  const hasAudio = !!doc.audio;
  return (
    <div className="transport" data-testid="transport">
      <div className="timecode" data-testid="timecode">
        <span className="current">{formatTimecode(ms)}</span>
        <span className="total">/ {formatTimecode(doc.audio?.durationMs ?? 0)}</span>
      </div>
      <div className="bpm" data-testid="bpm-display">
        BPM <strong>{doc.bpm.toFixed(2)}</strong>
      </div>
      <div className="buttons">
        <button onClick={() => controller.seekToStart()} disabled={!hasAudio} title="先頭へ">
          ⏮
        </button>
        <button data-testid="btn-play" className={playing ? 'on' : ''} onClick={() => void controller.togglePlay()} disabled={!hasAudio} title="再生 / 一時停止（Space）" data-playing={playing ? 'true' : 'false'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button data-testid="btn-stop" onClick={() => controller.stop()} disabled={!hasAudio} title="停止">
          ■
        </button>
        <button onClick={() => controller.seekToEnd()} disabled={!hasAudio} title="末尾へ">
          ⏭
        </button>
        <button data-testid="btn-loop" className={loop.enabled ? 'on' : ''} onClick={() => controller.toggleLoop()} disabled={!hasAudio} title="ループ（ルーラーを Shift+ドラッグで範囲指定）" data-on={loop.enabled ? 'true' : 'false'}>
          ループ {loop.enabled ? `${formatTimecode(loop.startMs, false)}–${formatTimecode(loop.endMs, false)}` : ''}
        </button>
        <button data-testid="btn-metronome" className={playback.metronome ? 'on' : ''} onClick={() => controller.toggleMetronome()} disabled={!hasAudio} data-on={playback.metronome ? 'true' : 'false'}>
          メトロノーム
        </button>
        <button data-testid="btn-preview" className={playback.preview ? 'on' : ''} onClick={() => controller.togglePreview()} disabled={!hasAudio} data-on={playback.preview ? 'true' : 'false'} title="編集中レベルのヒット時刻に試聴音を鳴らす">
          試聴音
        </button>
        <select data-testid="select-rate" value={playback.rate} onChange={(e) => controller.setRate(Number(e.target.value) as PlaybackPrefs['rate'])} disabled={!hasAudio}>
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r.toFixed(2)}x
            </option>
          ))}
        </select>
      </div>
      <div className="volumes">
        <label>
          原曲
          <input type="range" min={0} max={1} step={0.05} value={playback.volumeSong} onChange={(e) => editorStore.setPlayback({ volumeSong: Number(e.target.value) })} />
        </label>
        <label>
          メトロ
          <input type="range" min={0} max={1} step={0.05} value={playback.volumeMetronome} onChange={(e) => editorStore.setPlayback({ volumeMetronome: Number(e.target.value) })} />
        </label>
        <label>
          試聴
          <input type="range" min={0} max={1} step={0.05} value={playback.volumePreview} onChange={(e) => editorStore.setPlayback({ volumePreview: Number(e.target.value) })} />
        </label>
      </div>
    </div>
  );
}
