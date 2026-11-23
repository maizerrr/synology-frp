#!/bin/sh
# Bump the package version everywhere it is written down.
#
# Usage:
#   ./tools/bump.sh            # patch + 1   (1.0.1 -> 1.0.2)
#   ./tools/bump.sh 1.1.0      # explicit version
#   ./tools/bump.sh --show     # print the current version
#
# Why this exists: Package Center happily reuses a cached .spk when the version
# has not changed, which makes a fixed package look broken after reinstalling.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INFO="$ROOT/INFO"

current="$(sed -n 's/^version="\(.*\)"/\1/p' "$INFO")"
[ -n "$current" ] || { echo "cannot read version from INFO" >&2; exit 1; }

if [ "${1:-}" = "--show" ]; then
    echo "$current"
    exit 0
fi

if [ -n "${1:-}" ]; then
    next="$1"
else
    major="$(echo "$current" | cut -d. -f1)"
    minor="$(echo "$current" | cut -d. -f2)"
    patch="$(echo "$current" | cut -d. -f3)"
    next="$major.$minor.$((patch + 1))"
fi

echo "$current" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || {
    echo "unexpected current version: $current" >&2
    exit 1
}
echo "$next" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || {
    echo "not a valid version: $next" >&2
    exit 1
}

python3 - "$INFO" "$current" "$next" "$ROOT" <<'PY'
import pathlib
import sys

info_path, current, new, root = sys.argv[1], sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])

info = pathlib.Path(info_path)
text = info.read_text(encoding="utf-8")
info.write_text(text.replace('version="%s"' % current, 'version="%s"' % new, 1), encoding="utf-8")

# keep the runtime version strings in step with INFO
for path in root.glob("src/backend/*/app.py"):
    body = path.read_text(encoding="utf-8")
    body = body.replace('VERSION = "%s"' % current, 'VERSION = "%s"' % new, 1)
    path.write_text(body, encoding="utf-8")

for path in root.glob("src/backend/*/__init__.py"):
    body = path.read_text(encoding="utf-8")
    body = body.replace('__version__ = "%s"' % current, '__version__ = "%s"' % new, 1)
    path.write_text(body, encoding="utf-8")
PY

echo "version: $current -> $next"
