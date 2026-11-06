# ゲーム用譜面形式 `kosen-rhythm-chart` formatVersion 1

譜面エディターが書き出し、高専祭ゲームアプリ（ネオンヒット 楽曲譜面モード）が読み込む共通形式です。
型・実行時スキーマ・検証はすべて `packages/chart-format` に一元化され、両アプリが同じコードを使います。

## 書き出しフォルダ

```text
<trackId>/
  chart.json
  audio.mp3        # 元が MP3 なら再エンコードせずバイト列コピー。WAV/M4A/OGG は拡張子を維持
```

- `chart.json` の `audioFile` は実ファイル名と一致します。
- `trackId` とフォルダ名は `^[a-z0-9][a-z0-9_-]{0,63}$`。パス区切り、`..`、OS 予約名は使えません。

## JSON 例

```json
{
  "format": "kosen-rhythm-chart",
  "formatVersion": 1,
  "trackId": "sample-track",
  "title": "曲名",
  "artist": "",
  "audioFile": "audio.mp3",
  "audioSha256": "64文字のSHA-256（小文字16進）",
  "durationMs": 180000,
  "bpm": 128.0,
  "offsetMs": 0,
  "analysis": { "engineVersion": "1.0.0", "analyzedAt": "2026-11-05T00:00:00.000Z" },
  "choruses": [
    { "id": "chorus-1", "startMs": 45000, "endMs": 75000, "confidence": 0.82, "source": "detected" }
  ],
  "levels": {
    "1": { "displayName": "LEVEL 1", "notes": [ { "id": "l1-note-1", "hitAtMs": 1250, "source": "generated", "reason": "downbeat", "type": "tap" } ] },
    "2": { "displayName": "LEVEL 2", "notes": [] },
    "3": { "displayName": "LEVEL 3", "notes": [] },
    "4": { "displayName": "LEVEL 4", "notes": [] }
  }
}
```

## フィールド

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `format` | `"kosen-rhythm-chart"` | 完全一致が必要 |
| `formatVersion` | `1` | 対応バージョン一覧は `SUPPORTED_FORMAT_VERSIONS`。未知の値は読み込まず日本語で非対応と表示 |
| `trackId` | string | 安定した楽曲ID。ランキングキーの一部 |
| `title`, `artist` | string | 表示用。空文字可 |
| `audioFile` | string | フォルダ直下の相対ファイル名。`/`、`\\`、`..`、絶対パス、隠しファイル、予約名は不可 |
| `audioSha256` | string | 実音声の SHA-256。インポート時・書き出し後に照合 |
| `durationMs` | 整数 | 正の整数。上限 30 分 |
| `bpm` | number | 30～300 |
| `offsetMs` | 整数 | 最初の拍の位置（参考値。判定には使わない） |
| `analysis.engineVersion` | string | 解析エンジンのバージョン |
| `analysis.analyzedAt` | string | ISO 8601 |
| `choruses[]` | object | `startMs < endMs`、曲内、重なりなし。`source` は `detected` / `manual` |
| `levels["1".."4"]` | object | 4レベルすべて必須。`notes[]` はレベル内で `id` と `hitAtMs` が一意 |
| `notes[].hitAtMs` | 整数 | 楽曲時刻（ms）。`0 <= hitAtMs < durationMs` |
| `notes[].source` | `generated` / `manual` | 手作業音符の識別 |
| `notes[].reason` | string（任意） | `downbeat` / `beat` / `offbeat` / `onset` / `subdivision` / `manual` など生成理由 |
| `notes[].type` | string（任意） | `tap`（既定、1 回押す）または `mash`（連打）。未知の値は通常ヒットとして扱い警告 |
| `notes[].durationMs` | 整数（`type: "mash"` のとき必須） | 連打区間の長さ。200ms 以上、`hitAtMs + durationMs <= durationMs`。区間内に同一レベルの他のヒットがあればエラー。難易度間除外と最小間隔は区間全体に適用 |

| `generationRules` | object（任意） | エディターが付ける生成ルール。`crossLevelExclusionMs`（現在 0）、`levelPriority`（`[1,2,3,4]`）、`crossLevelNotesAreExclusive`（現在 false）。ゲームは参照しなくてよい |

追加フィールドは許可されます（無視されます）。必須項目を変更するときは `formatVersion` を上げ、`SUPPORTED_FORMAT_VERSIONS` と `validateChart` を更新してください。

## 検証（`validateChart` / `verifyChartPackage`）

エラー（読み込み拒否）:
`format` 不一致、未対応 `formatVersion`、構造エラー、不正な `trackId`、不正な `audioFile`、`durationMs` 上限超過、BPM 範囲外、
サビ区間の範囲外・順序・重なり、レベル欠落、音符IDの重複、`hitAtMs` の範囲外・非整数・同一レベル内重複、音声欠落、
音声がフォルダ外を参照（`../`、絶対パス、シンボリックリンク）、SHA-256 不一致、音声サイズ超過。

エディターの書き出し前検証では、`minGapAsError`（同一レベルの最小間隔違反）をエラーとして扱います。異なる難易度間の同時刻・80ms以内の近接・連打区間の重なりは許可し、生成・編集・読み込み・書き出しで制限しません。

警告（読み込み可、表示のみ）:
レベルごとの最小間隔違反、`hitAtMs < 3000` の音符（ゲーム開始時にレーン途中へ出現）、音符のないレベル、未知の `type`。

正規化: 音符は `hitAtMs` 昇順、サビ区間は開始順に並べ替えられます。入力オブジェクトは変更しません。

## ランキングキー

```text
neon-hit:song:<trackId>:<audioSha256>:v<formatVersion>:L<level>
```

曲・音声ハッシュ・形式バージョン・レベルのどれかが違えば別ランキングです。音声や譜面を差し替えてハッシュが変わると旧ランキングは引き継がれません。
固定譜面モードは `neon-hit:fixed:<chartId>` です。

## 判定仕様（ネオンヒット）

| 項目 | 値 |
| --- | --- |
| PERFECT / GOOD / BAD | 差の絶対値 ≤ 80 / 160 / 220 ms |
| MISS | 220 ms を超えて未押下 |
| 得点 | 100 / 50 / 10 / 0 |
| コンボ | PERFECT と GOOD で加算。BAD、MISS、空押しで 0 |
| EARLY / LATE | 差が負なら EARLY、正なら LATE。PERFECT は表示しない |
| 入力遅延補正 | -200～+200 ms、10 ms 単位。`補正後押下時刻 = Mac受信時刻 - 補正値` |
| 判定対象 | 未判定音符のうち差が 220 ms 以内で最も近い1音。同距離なら早い `hitAtMs` |
| 球の移動時間 | 3000 ms（右から左） |

定数はすべて `packages/chart-format/src/constants.ts` の `JUDGE` / `SYNC` にあります。
