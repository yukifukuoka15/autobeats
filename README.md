# AutoBeats

高専祭 2026 のボタンゲーム「ネオンヒット」用の **譜面エディター** と、ゲームアプリです。
曲（MP3 など）を読み込むと、テンポ・拍・サビを自動で解析して LEVEL 1〜4 の譜面を作り、画面上で直して、ゲームに渡せる形で書き出せます。
ローカル音声の解析はオフラインで動作します。YouTubeからの取り込みにはインターネットを使います。macOS と Windows に対応します。

## はじめかた（ダウンロードして開くだけ）

1. [Releases](https://github.com/yukifukuoka15/autobeats/releases) から自分の PC 用のファイルをダウンロードします。

   | PC | ファイル |
   | --- | --- |
   | Mac（Apple Silicon / M1 以降） | `AutoBeats.Chart.Editor-x.y.z-mac-arm64.dmg` |
   | Mac（Intel） | `AutoBeats.Chart.Editor-x.y.z-mac-x64.dmg` |
   | Windows | `AutoBeats.Chart.Editor-x.y.z-win-x64-setup.exe`（インストーラー）または `AutoBeats.Chart.Editor-x.y.z-win-x64-portable.exe`（インストール不要、そのまま実行） |

   ゲームアプリ本体は `Kosenfes.Game-...` という名前の同じ種類のファイルです。

2. 開きます。署名をしていないため、初回だけ次の操作が必要です。
   - Mac: アプリを右クリック →「開く」→「開く」。（「開発元を確認できません」と出た場合）
   - Windows: 「Windows によって PC が保護されました」→「詳細情報」→「実行」。
3. 「楽曲を読み込む…」で曲を選び、「AI自動解析」を押します。波形と LEVEL 1〜4 のヒットが出ます。
4. 「プレイテスト」で遊んで確かめます。キーは **LEVEL 1 = Q またはスペース、LEVEL 2 = W、LEVEL 3 = O、LEVEL 4 = P**。
5. 「ゲーム用に書き出し…」でゲームに渡すフォルダ（`chart.json` + 音声）を作ります。

### よく使うキー

| キー | 動き |
| --- | --- |
| スペース | 再生 / 一時停止 |
| J | いまの位置（再生ヘッド）に、編集中レベルのヒットを置く（再生中にタップしても OK） |
| F（押している間） | 連打（面のヒット）を置く |
| ← → | 停止中: 少しずつ移動して音を確認（スクラブ）。Shift で大きく、Option / Alt で細かく |
| Cmd / Ctrl + ← → | 選んだヒットを動かす |
| Delete | 選んだヒットを消す |
| Cmd / Ctrl + Z | 元に戻す |
| Cmd / Ctrl + S | 保存 |
| Cmd / Ctrl + P | プレイテスト |

Windows では `Cmd` を `Ctrl`、`Option` を `Alt` と読み替えてください。

読み込んだ曲はアプリの中に保存され、左上の「ライブラリ」からいつでも開き直せます。

---

## 開発者向け

```text
autobeats/
  packages/chart-format     譜面 JSON の型・スキーマ・検証・判定定数・ランキングキー（両アプリ共有）
  packages/audio-analysis   純粋 TypeScript の楽曲解析（BPM・拍・オンセット・構成・サビ）と 4難易度生成
  apps/chart-editor         譜面エディター（独立した Electron アプリ）
  apps/kosenfes-game        高専祭ゲームアプリ（ネオンヒット: 固定譜面モード / 楽曲譜面モード、インポート管理、ランキング）
  docs/                     形式仕様・解析方式・手動確認手順
  fixtures/generated/       合成テスト音声（`npm run fixtures` で生成。著作物を含まない）
```

- 形式仕様: [docs/CHART_FORMAT.md](docs/CHART_FORMAT.md)
- 解析方式と限界: [docs/ANALYSIS.md](docs/ANALYSIS.md)
- 手動確認手順: [docs/MANUAL_CHECK.md](docs/MANUAL_CHECK.md)
- エディターの詳細: [apps/chart-editor/README.md](apps/chart-editor/README.md)
- ゲームアプリの詳細: [apps/kosenfes-game/README.md](apps/kosenfes-game/README.md)

### 動作要件

- macOS（Apple Silicon / Intel）または Windows 10 以降（64bit）
- 開発には Node.js 22 以上と npm
- 初回の `npm install` と `electron-builder` の Electron 取得にだけネットワークが必要です。アプリ実行時は一切通信しません。

### セットアップ

```bash
npm install
npm run fixtures        # テスト用の合成音声を生成（任意。テストが自動で要求）
```

npm 11 ではインストールスクリプトが既定で止められます。Electron のバイナリが展開されていない（`npx electron --version` が Node のバージョンを表示する）場合は
`npm approve-scripts electron` のあと `npm rebuild electron` を実行してください。

### 開発起動

| 目的 | コマンド |
| --- | --- |
| 譜面エディターだけを起動 | `npm run dev:editor` |
| 高専祭ゲームアプリだけを起動 | `npm run dev:game` |

2 つのアプリは完全に独立した Electron プロセスで、同時に起動できます。

### ビルドとパッケージ

```bash
npm run build                 # 両アプリを out/ へビルド
npm run package:mac:editor    # macOS 用 .app（署名なし、開発確認用）→ apps/chart-editor/release/mac-arm64/
npm run release:mac           # macOS 配布用 dmg / zip（Apple Silicon と Intel）
npm run package:win           # Windows 用インストーラー / ポータブル exe（Windows 上で実行）
```

GitHub Actions（`.github/workflows/release.yml`）は `v*` タグを push すると macOS と Windows の配布ファイルをビルドして Releases に添付します。`ci.yml` は push ごとに lint・typecheck・テストを実行します。

```bash
git tag v1.0.0 && git push origin v1.0.0
```

### テスト

```bash
npm run lint              # ESLint
npm run typecheck         # 全ワークスペースの tsc --noEmit
npm run test:unit         # vitest（packages と各アプリの unit）
npm run test:integration  # vitest（アプリ横断の integration）
npm run test:e2e:editor   # Playwright + Electron（エディター）
npm run test:e2e:game     # Playwright + Electron（ゲーム）
```

### 完全オフラインの方針

- クラウド AI、外部 API、CDN、外部フォント、外部音源、実行時のモデルダウンロードは使いません。
- 音声デコードは Chromium 内蔵デコーダー（`decodeAudioData`）、解析は純粋 TypeScript（Web Worker）です。
- UI 上の「AI自動解析」はローカル音響解析の呼称で、精度 100% ではありません。必ず手修正できる前提です。

### 依存関係とライセンス

本リポジトリは MIT ライセンスです（[LICENSE](LICENSE)）。

実行時（アプリに同梱）:

| パッケージ | ライセンス | 用途 |
| --- | --- | --- |
| react / react-dom | MIT | UI |
| zod | MIT | 実行時スキーマ検証 |
| electron（Chromium / Node） | MIT 等 | アプリ基盤 |
| Press Start 2P / DotGothic16（フォント） | SIL OFL 1.1 | エディターのピクセルフォント（同梱、ライセンス文書も同梱） |

開発時のみ:

| パッケージ | ライセンス | 用途 |
| --- | --- | --- |
| electron-vite, vite, @vitejs/plugin-react | MIT | ビルド |
| electron-builder | MIT | macOS / Windows パッケージ |
| typescript, typescript-eslint, eslint | Apache-2.0 / MIT | 型検査・静的解析 |
| vitest, playwright, @playwright/test | MIT | テスト |
| tsx | MIT | スクリプト実行 |
| @breezystack/lamejs | LGPL-3.0 | テスト用合成 MP3 の生成のみ。アプリには同梱しない |

### 既知の制限

- 解析は 4/4 固定・一定テンポ前提です。テンポ変化、変拍子、ルバート、反復のない構成ではサビ・拍の推定精度が落ちます。必ず手修正を前提にしてください（[docs/ANALYSIS.md](docs/ANALYSIS.md)）。
- LEVEL 1～4 のヒットは難易度間で 80ms 以内に重ならないよう生成・検証されます（`CROSS_LEVEL_EXCLUSION_MS`）。このため上位レベルのヒット数が下位より少なくなることがあり、その場合は警告を表示します。ゲームアプリ側の取り込み検証は従来どおりで、この規則は強制しません。
- 連打（`type: "mash"`）はエディターのプレイテストで判定できますが、ゲームアプリ側は未対応で通常ヒットとして扱います。
- 実物ボタンのシリアル接続はプレースホルダー（`SerialButtonDevice`、未接続表示）です。仮想ボタン（Space / J / F）で全機能を確認できます。
- ゲームアプリはシングルウィンドウ（全画面切替あり）で、デュアルディスプレイ対応は含みません。
- 配布パッケージは未署名です。配布時は各 `electron-builder.yml` に署名設定を追加してください。


## YouTubeリンクから取り込み（統合版 1.0.1）

配布版（インストーラー・ポータブル版）にはYouTube取得用ランタイムを同梱します。利用者がNode.js、Python、FFmpeg、Denoを別途導入する必要はありません。YouTubeのURLを上部の欄に貼り付けると、MP3変換・ライブラリ登録・波形生成まで自動で進みます。譜面生成は「AI自動解析」を押します。プレイリストは単曲として扱い、非公開動画などの取得エラーは画面に表示します。

### ソースから起動

- Windows: Node.js 22以上とPython 3.10以上を導入し、初回に `setup_youtube.bat`、その後 `start_windows.bat`。
- Mac: Node.js 22以上とPython 3.10以上を導入し、初回に `bash setup_youtube_mac.command`、その後 `bash start_mac.command`。Python依存関係はプロジェクト内の仮想環境へ導入します。

### 配布ファイルを作成

- Windows: `build_windows.bat`。エディターとゲームのsetup.exe・portable.exeを各 `apps/*/release` に作成します。
- Mac: `bash build_mac.command`。各 `apps/*/release` にDMG・ZIPを作成します。エディターのネイティブツールを含めるため、Apple Silicon版はApple Silicon Mac、Intel版はIntel Macでそれぞれビルドしてください。
- エディターのパッケージコマンドはYouTube用ランタイムを自動生成し、Python・FFmpeg・Denoを同梱します。
- Mac版のDMG生成と動作確認はMacが必要です。GitHub ActionsでApple Silicon・Intel用DMGとZIPを生成します。署名・公証は未設定です。

詳細は `YOUTUBE_INTEGRATION.md` を参照してください。
