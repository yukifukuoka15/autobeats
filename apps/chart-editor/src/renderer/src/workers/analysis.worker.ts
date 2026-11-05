import { AnalysisCancelledError, AudioInputError, analyzeAudio, buildWaveformPeaks, type AnalysisResult, type WaveformPeaks } from '@autobeats/audio-analysis';

export interface WorkerRequest {
  type: 'analyze';
  jobId: number;
  sampleRate: number;
  channels: Float32Array[];
  /** ピークだけ欲しいとき（解析をスキップ） */
  peaksOnly?: boolean;
}

export type WorkerResponse =
  | { type: 'progress'; jobId: number; stage: string; ratio: number; message: string }
  | { type: 'peaks'; jobId: number; peaks: WaveformPeaks }
  | { type: 'result'; jobId: number; result: AnalysisResult }
  | { type: 'error'; jobId: number; message: string; cancelled: boolean };

const ctx = self as unknown as Worker;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'analyze') return;
  const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);
  try {
    post({ type: 'progress', jobId: req.jobId, stage: 'peaks', ratio: 0, message: '波形ピークを生成' });
    const peaks = buildWaveformPeaks(req.channels, req.sampleRate);
    post({ type: 'peaks', jobId: req.jobId, peaks }, peaks.levels.flatMap((l) => [l.min.buffer, l.max.buffer]));
    if (req.peaksOnly) return;
    const result = await analyzeAudio(
      { sampleRate: req.sampleRate, channels: req.channels },
      {
        onProgress: (p) => post({ type: 'progress', jobId: req.jobId, stage: p.stage, ratio: p.ratio, message: p.message }),
        yieldToEventLoop: () => new Promise((r) => setTimeout(r, 0)),
      },
    );
    post({ type: 'result', jobId: req.jobId, result });
  } catch (err) {
    const cancelled = err instanceof AnalysisCancelledError;
    const message = err instanceof AudioInputError || err instanceof Error ? err.message : String(err);
    post({ type: 'error', jobId: req.jobId, message, cancelled });
  }
};
