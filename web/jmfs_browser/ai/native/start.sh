#!/bin/sh
set -eu
native_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(uname -sm)" != 'Darwin arm64' ]; then
  echo 'The MLX guide requires an Apple Silicon Mac.' >&2; exit 1
fi
mkdir -p "$native_dir/.cache" "$native_dir/.tmp"
export HF_HOME="$native_dir/.cache/huggingface"
export PIP_CACHE_DIR="$native_dir/.cache/pip"
export TMPDIR="$native_dir/.tmp"
if [ ! -x "$native_dir/.venv/bin/python" ]; then
  python3 -m venv "$native_dir/.venv"
fi
if [ ! -f "$native_dir/.venv/.jmfs-ready" ]; then
  "$native_dir/.venv/bin/python" -m pip install \
    'mlx==0.32.3' 'mlx-vlm==0.7.4' \
    'edge-lm @ git+https://github.com/TheStageAI/edge-lm.git@ddddf9fddc8750951f32ca98fa0fe19ad7e45fb8'
  touch "$native_dir/.venv/.jmfs-ready"
fi
exec "$native_dir/.venv/bin/python" "$native_dir/server.py"
