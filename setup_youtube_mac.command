#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
python3 -m venv .venv-youtube || exit 1
.venv-youtube/bin/python -m pip install -r apps/chart-editor/resources/youtube/requirements.txt
