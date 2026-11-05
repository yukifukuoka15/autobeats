#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="$PWD/tools/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"
python3 -m venv .venv-youtube || exit 1
export AUTOBEATS_PYTHON="$PWD/.venv-youtube/bin/python"
npm install || exit 1
npm run package:mac
result=$?
echo "Build finished (exit $result). See apps/*/release."
read -r
exit "$result"
