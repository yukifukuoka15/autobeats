import { useEffect } from 'react';
import { api } from './api';
import { Dialogs } from './components/Dialogs';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { TransportBar } from './components/TransportBar';
import { controller } from './controller';
import { handleKeyDown, handleKeyUp } from './shortcuts';
import { Timeline } from './timeline/Timeline';
import { PlaytestScreen } from './playtest/PlaytestScreen';
import { useEditorState } from './store/editorStore';

export function App() {
  const playtestOpen = useEditorState((s) => s.playtest.open);
  useEffect(() => {
    const offMenu = api.onMenu((action) => void controller.handleMenu(action));
    const offRecent = api.onMenuOpenRecent((id) => void controller.openRecentFromMenu(id));
    const offClose = api.onSaveThenClose(() => {
      void controller.save(false).then((ok) => {
        if (ok) void api.closeAfterSave();
      });
    });
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    // keyup が届かない状況（非アクティブ化・非表示・アンマウント）ではスクラブを必ず解除する
    const cancelScrub = () => {
      controller.scrub.cancel();
      controller.cancelMash();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') cancelScrub();
    };
    window.addEventListener('blur', cancelScrub);
    document.addEventListener('visibilitychange', onVisibility);
    void controller.checkRecovery();
    return () => {
      offMenu();
      offRecent();
      offClose();
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', cancelScrub);
      document.removeEventListener('visibilitychange', onVisibility);
      cancelScrub();
    };
  }, []);
  return (
    <div className="app" data-testid="app">
      <TopBar />
      <div className="body">
        <LeftPanel />
        <main className="center">
          <TransportBar />
          <Timeline />
        </main>
        <RightPanel />
      </div>
      <StatusBar />
      <Dialogs />
      {playtestOpen && <PlaytestScreen />}
    </div>
  );
}
