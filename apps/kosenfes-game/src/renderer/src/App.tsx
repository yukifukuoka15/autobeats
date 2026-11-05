import { useCallback, useEffect, useState } from 'react';
import type { AbortReason, FinishedResult, GameSettings, LibraryEntrySummary } from '../../shared/types';
import { api } from './api';
import { AdminScreen } from './screens/AdminScreen';
import { GameScreen } from './screens/GameScreen';
import { ResultScreen } from './screens/ResultScreen';

type Tab = 'admin' | 'game' | 'result';

export interface FinishedPayload {
  result: FinishedResult;
  abortReason: AbortReason | null;
  abortMessage: string | null;
}

export function App() {
  const [tab, setTab] = useState<Tab>('admin');
  const [settings, setSettings] = useState<GameSettings | null>(null);
  const [library, setLibrary] = useState<LibraryEntrySummary[]>([]);
  const [finished, setFinished] = useState<FinishedPayload | null>(null);

  const reload = useCallback(async () => {
    const [s, l] = await Promise.all([api.settings.get(), api.library.list()]);
    setSettings(s);
    setLibrary(l);
  }, []);

  useEffect(() => {
    // 非同期読み込み後に state を更新する（初回のみ）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const updateSettings = useCallback(async (patch: Partial<GameSettings>) => {
    const s = await api.settings.update(patch);
    setSettings(s);
  }, []);

  if (!settings) return <div className="content">読み込み中…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <h1>高専祭ゲーム / ネオンヒット</h1>
        <nav className="tabs">
          <button data-testid="tab-admin" className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>
            管理
          </button>
          <button data-testid="tab-game" className={tab === 'game' ? 'active' : ''} onClick={() => setTab('game')}>
            ゲーム
          </button>
          <button data-testid="tab-result" className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')} disabled={!finished}>
            結果
          </button>
        </nav>
        <div className="spacer" />
        <span className="muted" data-testid="mode-indicator">
          {settings.mode === 'song' ? '楽曲譜面モード' : '固定譜面モード'}
          {settings.mode === 'song' && settings.level ? ` / LEVEL ${settings.level}` : ''}
        </span>
        <button onClick={() => void api.app.toggleFullscreen()}>フルスクリーン</button>
      </header>
      <main className="content">
        {tab === 'admin' && <AdminScreen settings={settings} library={library} onSettings={updateSettings} onReload={reload} />}
        {tab === 'game' && (
          <GameScreen
            settings={settings}
            onFinished={(p) => {
              setFinished(p);
              setTab('result');
            }}
          />
        )}
        {tab === 'result' && finished && <ResultScreen payload={finished} onBack={() => setTab('game')} />}
      </main>
    </div>
  );
}
