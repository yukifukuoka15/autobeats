#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="$PWD/tools/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null; then echo "Node.js 22以上をインストールしてください。"; read -r; exit 1; fi
if [ -x .venv-youtube/bin/python ]; then export AUTOBEATS_PYTHON="$PWD/.venv-youtube/bin/python"; fi
if [ ! -d node_modules ]; then npm install || exit 1; fi
npm run dev:editor
