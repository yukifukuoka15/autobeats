import { useState } from 'react';
import { api } from '../api';
import type { FinishedPayload } from '../App';

interface Props {
  payload: FinishedPayload;
  onBack: () => void;
}

const ABORT_TEXT: Record<string, string> = {
  'audio-start-failed': '音声の開始を確認できなかったため中断しました。',
  'audio-desync': '音声と判定時計のずれが大きいため中断しました。',
  'audio-error': '音声再生の異常により中断しました。',
  user: 'プレイを中断しました。',
  'device-error': 'デバイスの異常により中断しました。',
  'window-closed': 'ウィンドウが閉じられたため中断しました。',
};

export function ResultScreen({ payload, onBack }: Props) {
  const { result, abortReason, abortMessage } = payload;
  const [name, setName] = useState('');
  const [registered, setRegistered] = useState<{ rank: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const register = async () => {
    const r = await api.game.registerName(result.sessionId, name.trim() || 'プレイヤー');
    if (r.ok) setRegistered({ rank: r.rank });
    else setError(r.reason);
  };

  return (
    <div className="result card" data-testid="result-screen">
      <h2>結果</h2>
      <p>
        {result.title}
        {result.level ? ` / LEVEL ${result.level}` : ' / 固定譜面'}
      </p>
      {abortReason ? (
        <div className="msg error" data-testid="abort-message">
          {ABORT_TEXT[abortReason] ?? '中断しました。'} {abortMessage ?? ''}（ランキング対象外）
        </div>
      ) : (
        <div className="big" data-testid="result-score">
          {result.score}
        </div>
      )}
      <div className="counts">
        <div>
          PERFECT<b data-testid="count-perfect">{result.counts.PERFECT}</b>
        </div>
        <div>
          GOOD<b data-testid="count-good">{result.counts.GOOD}</b>
        </div>
        <div>
          BAD<b data-testid="count-bad">{result.counts.BAD}</b>
        </div>
        <div>
          MISS<b data-testid="count-miss">{result.counts.MISS}</b>
        </div>
      </div>
      <p>
        最大コンボ: <b data-testid="result-maxcombo">{result.maxCombo}</b> / 空押し: {result.emptyPresses}
      </p>
      {result.rankingEligible && !registered && (
        <div className="row">
          {result.provisionalRank !== null ? (
            <span className="ok" data-testid="provisional-rank">
              {result.provisionalRank} 位にランクインします。
            </span>
          ) : (
            <span className="muted">上位10件には入りませんでした（登録できません）。</span>
          )}
          {result.provisionalRank !== null && (
            <>
              <input data-testid="name-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="名前" />
              <button data-testid="register-button" className="primary" onClick={() => void register()}>
                ランキングに登録
              </button>
            </>
          )}
        </div>
      )}
      {registered && (
        <div className="msg" data-testid="registered-message">
          登録しました{registered.rank !== null ? `（${registered.rank} 位）` : ''}。
        </div>
      )}
      {error && <div className="msg error">{error}</div>}
      <div className="row">
        <button data-testid="back-to-game" onClick={onBack}>
          ゲーム画面へ戻る
        </button>
      </div>
    </div>
  );
}
