#!/usr/bin/env python3
"""Link Lens icon generator (build-author tool, not used at runtime).

Draws the brand mark — a Deep Ocean teal rounded square with a white
magnifier-lens ring and a Sunset-coral link dot — using only the Python
standard library (zlib + struct PNG writer), and writes icon{16,32,48,128}.png.

Run from the icons/ directory:  python3 make_icons.py
"""
import math
import struct
import zlib

TEAL_TOP = (13, 148, 136)     # #0D9488
CYAN_BOTTOM = (6, 182, 212)   # #06B6D4
WHITE = (255, 255, 255)
CORAL = (249, 115, 22)        # #F97316


def png_bytes(size, pixels):
    """pixels: list of rows of (r, g, b, a) tuples."""
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b''
    for row in pixels:
        raw += b'\x00' + b''.join(struct.pack('BBBB', *px) for px in row)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw(size):
    s = float(size)
    radius = s * 0.22            # rounded-square corner radius
    # lens geometry (slightly up-left so the handle fits)
    lens_cx, lens_cy = s * 0.44, s * 0.44
    lens_r = s * 0.24
    ring_w = max(1.2, s * 0.075)
    dot_r = s * 0.10             # coral link dot inside the lens
    handle_w = max(1.2, s * 0.085)

    def rounded_square_alpha(x, y):
        """1 inside the rounded square, 0 outside (with 1px soft edge)."""
        pad = s * 0.03
        lo, hi = pad, s - pad
        cx = min(max(x, lo + radius), hi - radius)
        cy = min(max(y, lo + radius), hi - radius)
        d = math.hypot(x - cx, y - cy)
        edge = radius
        if x < lo or x > hi or y < lo or y > hi:
            return 0.0
        return max(0.0, min(1.0, edge - d + 0.8))

    def ring_alpha(x, y):
        d = math.hypot(x - lens_cx, y - lens_cy)
        return max(0.0, min(1.0, ring_w / 2 - abs(d - lens_r) + 0.6))

    def dot_alpha(x, y):
        d = math.hypot(x - lens_cx, y - lens_cy)
        return max(0.0, min(1.0, dot_r - d + 0.6))

    def handle_alpha(x, y):
        # segment from lens edge (45°) to corner
        x0 = lens_cx + lens_r * math.cos(math.radians(45))
        y0 = lens_cy + lens_r * math.sin(math.radians(45))
        x1, y1 = s * 0.76, s * 0.76
        vx, vy = x1 - x0, y1 - y0
        length2 = vx * vx + vy * vy
        t = max(0.0, min(1.0, ((x - x0) * vx + (y - y0) * vy) / length2))
        d = math.hypot(x - (x0 + vx * t), y - (y0 + vy * t))
        return max(0.0, min(1.0, handle_w / 2 - d + 0.6))

    rows = []
    for j in range(size):
        row = []
        for i in range(size):
            x, y = i + 0.5, j + 0.5
            bg_a = rounded_square_alpha(x, y)
            if bg_a <= 0:
                row.append((0, 0, 0, 0))
                continue
            base = lerp(TEAL_TOP, CYAN_BOTTOM, (x + y) / (2 * s))
            r, g, b = base
            # white lens ring + handle
            wa = max(ring_alpha(x, y), handle_alpha(x, y))
            if wa > 0:
                r = round(r + (WHITE[0] - r) * wa)
                g = round(g + (WHITE[1] - g) * wa)
                b = round(b + (WHITE[2] - b) * wa)
            # coral dot (under the ring so the ring stays crisp)
            da = dot_alpha(x, y) * (1 - wa)
            if da > 0:
                r = round(r + (CORAL[0] - r) * da)
                g = round(g + (CORAL[1] - g) * da)
                b = round(b + (CORAL[2] - b) * da)
            row.append((r, g, b, round(255 * bg_a)))
        rows.append(row)
    return rows


def main():
    for size in (16, 32, 48, 128):
        data = png_bytes(size, draw(size))
        name = f'icon{size}.png'
        with open(name, 'wb') as f:
            f.write(data)
        print(f'wrote {name} ({len(data)} bytes)')


if __name__ == '__main__':
    main()
