#!/bin/sh
# Assemble an installable DSM .spk into dist/.
set -eu

COPYFILE_DISABLE=1
export COPYFILE_DISABLE

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(sed -n 's/^version="\(.*\)"/\1/p' "$ROOT/INFO")"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
PKGROOT="$BUILD/pkgroot"
SPKDIR="$BUILD/spk"

PYTHON_BIN="$(command -v python3 || command -v python || true)"
[ -n "$VERSION" ] || { echo "cannot read version from INFO" >&2; exit 1; }
[ -n "$PYTHON_BIN" ] || { echo "python3 is required to generate icons" >&2; exit 1; }

# icons are generated, not committed by hand
if [ ! -f "$ROOT/PACKAGE_ICON.PNG" ] || [ ! -f "$ROOT/src/ui/images/icon_72.png" ]; then
    "$PYTHON_BIN" "$ROOT/tools/make_icon.py" >/dev/null
fi

rm -rf "$BUILD"
mkdir -p "$PKGROOT/ui/images" "$SPKDIR" "$DIST"

# --- payload ---------------------------------------------------------------
cp -R "$ROOT/src/backend" "$PKGROOT/backend"
find "$PKGROOT" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$PKGROOT" -name '*.pyc' -delete 2>/dev/null || true

cp -R "$ROOT/src/frontend/." "$PKGROOT/ui/"
cp "$ROOT/src/ui/config" "$PKGROOT/ui/config"
cp "$ROOT"/src/ui/images/icon_*.png "$PKGROOT/ui/images/"

if [ -f "$ROOT/vendor/frpc/frpc" ]; then
    mkdir -p "$PKGROOT/engine"
    cp "$ROOT/vendor/frpc/frpc" "$PKGROOT/engine/frpc"
    chmod 755 "$PKGROOT/engine/frpc"
    echo "bundled frpc: $(cat "$ROOT/vendor/frpc/VERSION" 2>/dev/null || echo '?')"
else
    echo "warning: no frpc binary in vendor/frpc (run make engine)" >&2
fi

# --format=ustar: macOS bsdtar defaults to pax, which injects a PaxHeader
# entry that DSM's package parser rejects ("Invalid file format").
tar --format=ustar -czf "$BUILD/package.tgz" -C "$PKGROOT" .

# --- spk skeleton ----------------------------------------------------------
sed '/^create_time=/d;/^extractsize=/d' "$ROOT/INFO" > "$SPKDIR/INFO"
printf 'create_time="%s"\nextractsize="%s"\n' \
    "$(date +%Y%m%d-%H:%M:%S)" "$(du -sk "$PKGROOT" | cut -f1)" >> "$SPKDIR/INFO"
[ -f "$ROOT/PACKAGE_ICON.PNG" ] && cp "$ROOT/PACKAGE_ICON.PNG" "$SPKDIR/"
[ -f "$ROOT/PACKAGE_ICON_256.PNG" ] && cp "$ROOT/PACKAGE_ICON_256.PNG" "$SPKDIR/"
cp -R "$ROOT/package/scripts" "$SPKDIR/scripts"
cp -R "$ROOT/package/conf" "$SPKDIR/conf"
chmod 755 "$SPKDIR/scripts/"*
cp "$BUILD/package.tgz" "$SPKDIR/package.tgz"

OUT="$DIST/synology-frp-${VERSION}.spk"

# Entry order matters: DSM reads INFO first. Never rely on shell glob order.
ENTRIES="INFO package.tgz scripts conf"
[ -f "$SPKDIR/PACKAGE_ICON.PNG" ] && ENTRIES="$ENTRIES PACKAGE_ICON.PNG"
[ -f "$SPKDIR/PACKAGE_ICON_256.PNG" ] && ENTRIES="$ENTRIES PACKAGE_ICON_256.PNG"

( cd "$SPKDIR" && tar --format=ustar -cf "$OUT" $ENTRIES )

# cheap self-check: the archive must start with the INFO entry and carry no
# metadata entries that DSM chokes on
if [ "$(head -c 4 "$OUT")" != "INFO" ]; then
    echo "build error: spk does not start with INFO (must be an uncompressed tar)" >&2
    exit 1
fi
first_entry="$(tar -tf "$OUT" | head -1)"
if [ "$first_entry" != "INFO" ]; then
    echo "build error: first archive entry is '$first_entry', expected INFO" >&2
    exit 1
fi
if tar -tf "$OUT" | grep -qE '(^|/)PaxHeader|(^|/)\._'; then
    echo "build error: archive contains pax/appledouble metadata entries" >&2
    exit 1
fi
echo "built: dist/$(basename "$OUT")"
