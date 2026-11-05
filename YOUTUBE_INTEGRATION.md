# YouTube統合版 1.0.1

## 利用方法
Windows版はsetup.exeでインストールするかportable.exeを起動してください。Pythonなどの追加導入は不要です。
上部のYouTube欄にリンクを貼ると、音声取得・MP3変換・ライブラリ登録・波形表示まで進みます。譜面生成は「AI自動解析」を押します。
既存のソース版はstart_windows.batで起動できます。

## Mac
ソースから起動：Node.js 22以上・Python 3.10以上を導入後、bash setup_youtube_mac.command、bash start_mac.command。
配布版生成：bash build_mac.command。Apple SiliconとIntelそれぞれのMacでビルドしてください。
Mac実機での検証、DMG生成、署名・公証はこのWindows環境では実施していません。

## 変更点
- YouTube URLからエディターへ直接取り込み。
- Vite開発環境の波形生成エラーをmodule Worker指定で修正。
- 配布版にPython実行環境、yt-dlp、FFmpeg、Denoを同梱。
- Windows・Macの起動／ビルドスクリプトと配布設定を更新。
- エディターとゲームを1.0.1へ更新。
