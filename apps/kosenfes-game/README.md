# 高専祭ゲームアプリ（`apps/kosenfes-game`）

ネオンヒット（実物ボタン1台のリズムゲーム）を動かす macOS 用 Electron アプリです。
従来の **固定譜面モード** に加え、譜面エディターで書き出した「楽曲ファイル＋`chart.json`」を取り込んで楽曲と同期してプレイする **楽曲譜面モード** を持ちます。
インターネット接続は不要で、外部 API・CDN・外部フォントは使いません。

## 起動とビルド

リポジトリのルートで依存関係を入れてから（`npm install`）:

| 目的 | コマンド（ルートで実行） |
| --- | --- |
| 開発起動（このアプリだけ） | `npm run dev:game` |
| 本番ビルド（`apps/kosenfes-game/out/`） | `npm run build -w apps/kosenfes-game` |
| macOS 向けパッケージ（`apps/kosenfes-game/release/mac-arm64/Kosenfes Game.app`） | `npm run package:mac -w apps/kosenfes-game` |
| 型チェック | `npm run typecheck -w apps/kosenfes-game` |
| Lint | `npx eslint apps/kosenfes-game` |
| Unit テスト | `npx vitest run --project kosenfes-game` |
| Integration テスト | `npx vitest run --project integration apps/kosenfes-game` |
| E2E（Playwright + Electron） | `npm run test:e2e -w apps/kosenfes-game` |

パッケージは Apple Silicon（arm64）向け・未署名（ad-hoc）です。初回起動で Gatekeeper に止められた場合は Finder で右クリック →「開く」を使ってください。
`npm run package:mac` 後に E2E を実行すると、パッケージ済み `.app` を起動して取り込み・楽曲準備ができることも確認します（`test/e2e/packaged.spec.ts`）。

テスト時は環境変数 `KOSENFES_USER_DATA` で保存先（Application Support 相当）を一時ディレクトリへ切り替えられます。

## 保存データ（`~/Library/Application Support/@autobeats/kosenfes-game/`）

| ファイル | 内容 |
| --- | --- |
| `library/index.json` | 取り込み済み楽曲の一覧（曲名、長さ、BPM、各レベルの音符数、ハッシュ、検証状態） |
| `library/<trackId>--<sha256先頭12桁>/` | 検証済みの `chart.json` と音声のコピー |
| `settings.json` | モード、選択曲、レベル、デバイス、入力遅延補正、音量 |
| `rankings.json` | ランキング（キーごとに上位10件） |
| `rankings.backup-<日時>.json` | 編集・削除前の自動バックアップ |
| `*.corrupt-<時刻>` | 壊れていたファイルの退避コピー（起動時に初期化した場合） |

すべての JSON は読み込み時に zod で検証し、壊れていれば退避して初期化します（クラッシュしません）。書き込みは一時ファイル＋rename の atomic write です。

## 管理画面

1. **取り込み**: 「フォルダから取り込む」または「chart.json を選択して取り込む」。選択されたフォルダ内だけを解決し、`chart.json` のスキーマ、`audioFile` の相対性（`../`・絶対パス・シンボリックリンク拒否）、音声の存在とサイズ、SHA-256 一致、`formatVersion` を検証します。不正なら日本語の理由を表示して登録しません。
2. **重複**: 同じ `trackId` かつ同じ音声ハッシュは登録済みとして拒否します。
3. **衝突**: 同じ `trackId` で内容が違う場合はダイアログで「置換する」「別IDで登録する（`<trackId>-2` …、`chart.json` の `trackId` も更新）」「キャンセル」を選べます。プレイ中の楽曲は置換できません。
4. **一覧**: 曲名、ID、長さ、BPM、L1～L4 の音符数、検証状態（OK/NG とハッシュ先頭8桁）。「選択」で楽曲譜面モードの対象になります。
5. **削除**: 確認ダイアログ付き。プレイ中の楽曲は削除できません。ランキング記録は残ります。
6. **ランキング**: 曲＋レベルごと（固定譜面は別キー）に上位10件。同点は同順位。名前編集・削除（削除前に自動バックアップ）・手動バックアップ。

## ゲーム設定

- モード（楽曲譜面 / 固定譜面）、LEVEL 1～4、使用する実物ボタン（1台）、入力遅延補正（−200～+200 ms、10 ms 刻み、`補正後押下時刻 = Mac受信時刻 − 補正値`）、音楽音量、効果音音量。
- 設定は変更のたびに保存され、次回起動時に復元されます。
- 曲・譜面・音声・デバイスのどれかが不正なら「開始」が無効になり、理由を日本語で表示します。

## 仮想デバイス

キーボードの **Space / J / F** が仮想ボタンです（キーリピートは無視、押しっぱなしは解放まで次の押下を受け付けません）。
`設定 → 実物ボタン` で「仮想ボタン（キーボード）」を選んでください。LED 色はゲーム画面左上の丸で表示されます（PERFECT 白 100ms、GOOD 黄 100ms、BAD 橙 150ms、空押し 紫 150ms、待機は暗い赤）。

## 実物ボタンの接続先

`src/main/device/serial.ts` の `SerialButtonDevice` がプレースホルダーです。実機プロトコルが決まったら `connect()` でポートを開き、受信した押下／解放を `listeners` に流し（`receivedAtMs` は main の `performance.now()`）、`setLed()` で色コマンドを送ってください。ゲーム時計は LED の応答を待ちません。ネイティブモジュールは追加していません。

## 時計と判定の設計

- main process が唯一の正本です（ゲーム時刻、判定、音符状態、スコア、コンボ、終了状態）。renderer は得点を計算しません。
- カウントダウン 3 秒の後、renderer が `AudioContext` で音声を予約開始し、実際に鳴り始めた直後に `audioStarted({ latencyMs })` を送ります。main は「受信時刻 − latencyMs」を楽曲時刻 0 とし、以後 `songTime = performance.now() − songStart` だけで判定します。
- renderer は 250 ms ごとに音声位置を報告します。差が 120 ms を 5 回連続で超える、または 3 秒報告が途絶えると `audio-desync` で中断します。ハンドシェイクが 5 秒来ない／開始遅延が 1.5 秒を超える場合は `audio-start-failed` で中断します（定数は `packages/chart-format/src/constants.ts` の `SYNC`）。
- 判定: |差| ≤ 80 ms PERFECT(100)、≤ 160 ms GOOD(50)、≤ 220 ms BAD(10)、猶予超過で MISS(0)。PERFECT/GOOD だけコンボ増加。押下ごとに未判定音符のうち 220 ms 以内で最も近い1音だけを判定し、同距離なら早い音符を優先。候補がなければ空押し（コンボ 0、音符は消費しない）。
- 終了規則（`session.ts` の1か所で定義）: 楽曲時刻 ≥ max(曲の長さ, 最後の音符 + 220 ms) + 300 ms。
- 中断・終了・画面離脱時にタイマー、音声、購読、LED を破棄します。中断したプレイはランキング対象外です。

## 手動確認手順

1. **取り込み**: エディターで書き出したフォルダを管理画面から取り込み、一覧に曲名・長さ・BPM・音符数・OK が出ること。壊れた `chart.json` や音声差し替え（ハッシュ不一致）が日本語で拒否されること。
2. **仮想デバイスでの楽曲同期プレイ**: 曲と LEVEL を選び、デバイスを仮想ボタンにしてゲーム画面で「開始」。3 秒カウントダウン後に音が鳴り、球が右から左へ 3 秒かけて流れ、判定ラインで Space を押すと PERFECT/GOOD/BAD が出ること。曲の終わりで結果画面に移り、名前登録でランキングに入ること。
3. **実物ボタンで確認すべき遅延補正**: 実機接続後、メトロノーム的に正確に押しても LATE が多い場合は入力遅延補正を +10 ms ずつ、EARLY が多い場合は −10 ms ずつ調整し、PERFECT が最も多くなる値を保存してください（機材・ケーブル・OS 負荷で変わります）。
4. **固定譜面モードの回帰**: モードを固定譜面にして開始し、クリック音に合わせて球が流れ、判定・スコア・終了（60 秒）が従来どおり動くこと。ランキングキーは `neon-hit:fixed:default-v1` で楽曲モードと混ざらないこと。
5. **異常系**: プレイ中に楽曲を削除／置換できないこと。音声を準備できないとき「開始」が無効になること。
6. **ネットワーク切断**: Wi‑Fi をオフにしてパッケージ済みアプリを起動し、1～4 が同じように動くこと。
