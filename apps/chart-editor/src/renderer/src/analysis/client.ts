import type { AnalysisResult, WaveformPeaks } from '@autobeats/audio-analysis';
import type { WorkerRequest, WorkerResponse } from '../workers/analysis.worker';

export interface AnalysisJobHandle {
  jobId: number;
  cancel: () => void;
  done: Promise<AnalysisResult | null>;
}

export interface AnalysisCallbacks {
  onProgress: (stage: string, ratio: number, message: string) => void;
  onPeaks: (peaks: WaveformPeaks) => void;
}

/**
 * 解析ワーカーのクライアント。
 * ジョブごとに jobId を持ち、キャンセル時は worker を terminate して次回は新しい worker を使う。
 * 古い jobId の応答は無視する（世代管理）。
 */
export class AnalysisClient {
  private worker: Worker | null = null;
  private currentJobId = 0;

  private spawn(): Worker {
    // Vite の開発サーバーは import を含むため module Worker として起動する。
    if (!this.worker) this.worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    return this.worker;
  }

  /** AudioBuffer から PCM をコピーして解析を開始する */
  start(jobId: number, buffer: AudioBuffer, callbacks: AnalysisCallbacks, peaksOnly = false): AnalysisJobHandle {
    this.currentJobId = jobId;
    const worker = this.spawn();
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = new Float32Array(buffer.length);
      buffer.copyFromChannel(ch, c);
      channels.push(ch);
    }
    const done = new Promise<AnalysisResult | null>((resolve, reject) => {
      const handler = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (msg.jobId !== jobId || this.currentJobId !== jobId) return; // 古いジョブの応答は無視
        if (msg.type === 'progress') callbacks.onProgress(msg.stage, msg.ratio, msg.message);
        else if (msg.type === 'peaks') {
          callbacks.onPeaks(msg.peaks);
          if (peaksOnly) {
            cleanup();
            resolve(null);
          }
        } else if (msg.type === 'result') {
          cleanup();
          resolve(msg.result);
        } else if (msg.type === 'error') {
          cleanup();
          if (msg.cancelled) resolve(null);
          else reject(new Error(msg.message));
        }
      };
      const errorHandler = (e: ErrorEvent) => {
        cleanup();
        reject(new Error(e.message || 'ワーカーでエラーが発生しました'));
      };
      const cleanup = () => {
        worker.removeEventListener('message', handler);
        worker.removeEventListener('error', errorHandler);
      };
      worker.addEventListener('message', handler);
      worker.addEventListener('error', errorHandler);
    });
    const req: WorkerRequest = { type: 'analyze', jobId, sampleRate: buffer.sampleRate, channels, peaksOnly };
    worker.postMessage(
      req,
      channels.map((c) => c.buffer),
    );
    return {
      jobId,
      done,
      cancel: () => {
        if (this.currentJobId !== jobId) return;
        this.currentJobId = -1;
        worker.terminate();
        this.worker = null;
      },
    };
  }
}

/** 世代管理の純粋ロジック（テスト用）: 現在のジョブ ID と一致するときだけ結果を適用する */
export function shouldApplyResult(currentJobId: number, resultJobId: number, cancelledJobIds: ReadonlySet<number>): boolean {
  return currentJobId === resultJobId && !cancelledJobIds.has(resultJobId);
}
