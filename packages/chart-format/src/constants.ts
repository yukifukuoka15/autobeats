/**
 * 譜面形式・ゲーム判定・エディター既定値の一元管理。
 * エディターとゲームの両方がこのファイルの値だけを参照する。
 */

export const CHART_FORMAT = 'kosen-rhythm-chart' as const;
export const CURRENT_FORMAT_VERSION = 1 as const;
export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [1];

export const CHART_FILE_NAME = 'chart.json' as const;

/** 音声入力の実用上限 */
export const AUDIO_LIMITS = {
  /** 500MB */
  maxFileBytes: 500 * 1024 * 1024,
  /** 30分 */
  maxDurationMs: 30 * 60 * 1000,
  /** 1秒未満は譜面として成立しない */
  minDurationMs: 1000,
  /** chart.json の最大サイズ（10MB） */
  maxChartJsonBytes: 10 * 1024 * 1024,
  /** 1レベルあたりの最大音符数（異常データ防御） */
  maxNotesPerLevel: 20000,
  /** サビ区間の最大数 */
  maxChoruses: 64,
} as const;

export const SUPPORTED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg'] as const;
export type SupportedAudioExtension = (typeof SUPPORTED_AUDIO_EXTENSIONS)[number];

export const BPM_RANGE = { min: 30, max: 300 } as const;

export const LEVEL_NUMBERS = [1, 2, 3, 4] as const;
export const LEVEL_KEYS = ['1', '2', '3', '4'] as const;

/** ネオンヒット判定仕様（prompts/07_NEON_HIT_GAME.md 準拠） */
export const JUDGE = {
  perfectMs: 80,
  goodMs: 160,
  badMs: 220,
  /** 球が右から左へ流れる移動時間 */
  approachMs: 3000,
  /** 開始カウントダウン */
  countdownMs: 3000,
  score: { PERFECT: 100, GOOD: 50, BAD: 10, MISS: 0 } as const,
  inputOffset: { minMs: -200, maxMs: 200, stepMs: 10 } as const,
  led: {
    PERFECT: { color: 'white', durationMs: 100 },
    GOOD: { color: 'yellow', durationMs: 100 },
    BAD: { color: 'orange', durationMs: 150 },
    EMPTY: { color: 'purple', durationMs: 150 },
    /** ゲーム中の待機色 */
    idle: { color: 'dim-red', durationMs: 0 },
  } as const,
} as const;

/** 楽曲同期時計の許容値 */
export const SYNC = {
  /** 音声開始ハンドシェイクを待つ上限 */
  startHandshakeTimeoutMs: 5000,
  /** 開始要求から実際の音声開始までの許容遅延 */
  maxStartLatencyMs: 1500,
  /** 定期観測で許容する main 時計と音声位置の差 */
  maxDriftMs: 120,
  /** 連続で許容差を超えた回数がこの値に達したら異常中断 */
  driftAbortCount: 5,
  /** 観測間隔 */
  driftReportIntervalMs: 250,
  /** 観測が途絶えたと見なす時間 */
  driftReportTimeoutMs: 3000,
} as const;

/** レベル別の自動生成既定値 */
export interface LevelGenerationSettings {
  /** 採用する候補の密度（0.0～1.0 程度。大きいほど多く採用） */
  density: number;
  /** 同一レベル内の最小間隔（ms） */
  minGapMs: number;
  /** サビ区間での密度倍率 */
  chorusDensityMultiplier: number;
  /** 拍へのスナップ強度（0=オンセット位置のまま、1=拍グリッドへ完全吸着） */
  beatSnapStrength: number;
}

export const DEFAULT_LEVEL_SETTINGS: Readonly<Record<1 | 2 | 3 | 4, LevelGenerationSettings>> = {
  1: { density: 0.35, minGapMs: 600, chorusDensityMultiplier: 1.35, beatSnapStrength: 0.9 },
  2: { density: 0.5, minGapMs: 400, chorusDensityMultiplier: 1.45, beatSnapStrength: 0.8 },
  3: { density: 0.65, minGapMs: 280, chorusDensityMultiplier: 1.55, beatSnapStrength: 0.6 },
  4: { density: 0.8, minGapMs: 220, chorusDensityMultiplier: 1.65, beatSnapStrength: 0.4 },
};

export const LEVEL_DISPLAY_NAMES: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: 'LEVEL 1',
  2: 'LEVEL 2',
  3: 'LEVEL 3',
  4: 'LEVEL 4',
};

/** ゲームID（ランキングキーの先頭要素として安定させる） */
export const NEON_HIT_GAME_ID = 'neon-hit' as const;
export const NEON_HIT_SONG_MODE_ID = 'neon-hit-song' as const;

/**
 * 難易度間除外幅（ms）。異なるレベルの音符同士は、時刻差がこの値以下なら重複とみなす（境界を含む）。
 * 自動生成、手動編集、リアルタイム検証、読込時検出、書き出し検証はすべてこの値と crossLevel.ts の判定関数を使う。
 */
export const CROSS_LEVEL_EXCLUSION_MS = 80 as const;

/** 自動生成・修復の優先順位。先のレベルの音符を優先して保持する */
export const LEVEL_PRIORITY: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];

/** 連打（mash）ヒットの仕様 */
export const MASH = {
  /** 手動入力で連打として確定する最小長さ（これ未満は通常ヒット） */
  minDurationMs: 200,
  /** この間隔ごとに 1 回押すのを「満点」の目安にする（必要回数 = ceil(durationMs / この値)） */
  requiredPressIntervalMs: 200,
  /** 区間内の押下 1 回ごとの加点 */
  bonusPerPress: 10,
  /** 区間の前後でも押下を連打として数える猶予 */
  edgeToleranceMs: 80,
} as const;
