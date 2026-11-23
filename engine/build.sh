#!/bin/sh
# Build frpc from this repository and stage it in vendor/frpc/.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="synology-frp-build:latest"
OUT="$ROOT/vendor/frpc"

if ! docker info >/dev/null 2>&1; then
    echo "docker daemon is not running" >&2
    exit 1
fi

docker build -f "$ROOT/engine/Dockerfile" -t "$IMAGE" "$ROOT"

container="$(docker create "$IMAGE")"
rm -rf "$OUT"
mkdir -p "$OUT"
docker cp "$container:/out/." "$OUT/"
docker rm "$container" >/dev/null

[ -x "$OUT/frpc" ] || { echo "missing frpc binary" >&2; exit 1; }
echo "frpc ready:"
ls -la "$OUT"
du -sh "$OUT"
