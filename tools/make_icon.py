#!/usr/bin/env python3
"""Generate the package / desktop icons (pure stdlib PNG writer)."""

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TOP = (53, 196, 164)
BOTTOM = (23, 148, 122)
FG = (255, 255, 255, 255)


def _chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + b"".join(bytes(px) for px in row) for row in rows)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    blob = (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(raw, 9)) + _chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(blob)


def _in_rounded_rect(x, y, size, radius):
    pad = size * 0.06
    left, right = pad, size - pad
    top, bottom = pad, size - pad
    if x < left or x > right or y < top or y > bottom:
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def _in_arrow(x, y, size):
    """A right-pointing arrow: the tunnel going out."""
    shaft_left, shaft_right = size * 0.26, size * 0.58
    shaft_top, shaft_bottom = size * 0.44, size * 0.56
    if shaft_left <= x <= shaft_right and shaft_top <= y <= shaft_bottom:
        return True
    # head
    ax, ay = shaft_right, size * 0.30
    bx, by = shaft_right, size * 0.70
    cx, cy = size * 0.76, size * 0.50
    d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def render(size, samples=3):
    radius = size * 0.23
    rows = []
    step = 1.0 / samples
    for py in range(size):
        row = []
        for px in range(size):
            bg_hits = 0
            fg_hits = 0
            for sy in range(samples):
                for sx in range(samples):
                    x = px + (sx + 0.5) * step
                    y = py + (sy + 0.5) * step
                    if _in_rounded_rect(x, y, size, radius):
                        bg_hits += 1
                        if _in_arrow(x, y, size):
                            fg_hits += 1
            total = samples * samples
            alpha = int(255 * bg_hits / total)
            if alpha == 0:
                row.append((0, 0, 0, 0))
                continue
            mix = fg_hits / bg_hits if bg_hits else 0
            ratio = py / max(size - 1, 1)
            base = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * ratio) for i in range(3))
            colour = tuple(int(base[i] + (FG[i] - base[i]) * mix) for i in range(3))
            row.append((colour[0], colour[1], colour[2], alpha))
        rows.append(row)
    return rows


def main():
    targets = [
        (os.path.join(ROOT, "PACKAGE_ICON.PNG"), 72),
        (os.path.join(ROOT, "PACKAGE_ICON_256.PNG"), 256),
    ]
    for size in (16, 24, 32, 48, 64, 72, 256):
        targets.append((os.path.join(ROOT, "src", "ui", "images", "icon_%d.png" % size), size))
    for path, size in targets:
        samples = 3 if size >= 48 else 2
        write_png(path, size, render(size, samples))
        print("wrote", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
