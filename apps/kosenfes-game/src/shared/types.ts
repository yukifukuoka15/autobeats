/** main / preload / renderer で共有する IPC 型。絶対パスは含めない。 */
import type { ChorusSection, Judgement, EarlyLate, LevelNumber } from '@autobeats/chart-format';

export type GameMode = 'fixed' | 'song';

export interface LibraryEntrySummary {
  trackId: string;
  audioSha256: string;
  title: string;
  artist: string;
  durationMs: number;
  bpm: number;
  noteCounts: Record<'1' | '2' | '3' | '4', number>;
  importedAt: string;
  verified: { ok: boolean; checkedAt: string; errors: string[] };
}

export interface GameSettings {
  mode: GameMode;
  selectedTrackId: string | null;
  selectedAudioSha256: string | null;
  level: LevelNumber;
  deviceId: string;
  inputOffsetMs: number;
  /** 0～1 */
  musicVolume: number;
  /** 0～1 */
  sfxVolume: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  kind: 'virtual' | 'serial';
  connected: boolean;
}

export type ImportResult =
  | { status: 'imported'; entry: LibraryEntrySummary; warnings: string[] }
  | { status: 'duplicate'; entry: LibraryEntrySummary }
  | { status: 'conflict'; pendingId: string; existing: LibraryEntrySummary; incoming: { trackId: string; title: string; audioSha256: string } }
  | { status: 'rejected'; errors: string[] }
  | { status: 'cancelled' };

export interface RankingEntry {
  id: string;
  name: string;
  score: number;
  maxCombo: number;
  counts: Record<Judgement, number>;
  playedAt: string;
}

export interface RankingRow extends RankingEntry {
  rank: number;
}

export type SessionState = 'idle' | 'ready' | 'countdown' | 'playing' | 'finished' | 'aborted';

export type AbortReason = 'audio-start-failed' | 'audio-desync' | 'audio-error' | 'user' | 'device-error' | 'window-closed';

export type NoteState = 0 | 1 | 2 | 3 | 4; // 0=未判定 1=PERFECT 2=GOOD 3=BAD 4=MISS

export interface JudgementEvent {
  kind: 'judgement';
  sessionId: string;
  noteIndex: number;
  judgement: Judgement;
  earlyLate: EarlyLate;
  deltaMs: number;
  songTimeMs: number;
}

export interface EmptyPressEvent {
  kind: 'empty-press';
  sessionId: string;
  songTimeMs: number;
}

export interface StateEvent {
  kind: 'state';
  sessionId: string;
  state: SessionState;
  abortReason?: AbortReason;
  abortMessage?: string;
}

export type SessionEvent = JudgementEvent | EmptyPressEvent | StateEvent;

export interface SessionSnapshot {
  sessionId: string;
  state: SessionState;
  score: number;
  combo: number;
  maxCombo: number;
  counts: Record<Judgement, number>;
  emptyPresses: number;
  noteStates: NoteState[];
  songTimeMs: number;
  abortReason?: AbortReason;
  lastJudgement: { judgement: Judgement | 'EMPTY'; earlyLate: EarlyLate; atMs: number } | null;
}

export interface PreparedGame {
  ok: true;
  sessionId: string;
  mode: GameMode;
  title: string;
  level: LevelNumber | null;
  notes: number[];
  choruses: ChorusSection[];
  durationMs: number;
  bpm: number;
  countdownMs: number;
  approachMs: number;
  /** 楽曲モードのみ。kosenfes-media://audio/<token> */
  audioToken: string | null;
  rankingKey: string;
  inputOffsetMs: number;
  musicVolume: number;
  sfxVolume: number;
}

export type PrepareResult = PreparedGame | { ok: false; reasons: string[] };

export interface FinishedResult {
  sessionId: string;
  score: number;
  maxCombo: number;
  counts: Record<Judgement, number>;
  emptyPresses: number;
  rankingEligible: boolean;
  rankingKey: string;
  /** 登録した場合の順位（上位10件に入らなければ null） */
  provisionalRank: number | null;
  title: string;
  level: LevelNumber | null;
}

export interface LedState {
  color: string;
  untilMs: number;
}
