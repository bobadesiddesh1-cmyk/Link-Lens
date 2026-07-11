#!/usr/bin/env python3
"""Link Lens icon generator (build-author tool, not used at runtime).

Brand mark: two interlocked chain links on a diagonal — the back link in
the Deep Ocean teal→cyan gradient, the front link in the Sunset
coral→amber gradient — on a TRANSPARENT background (no generic rounded
square). Where the front link crosses the back one, the back link is cut
with a small gap, the standard flat "link" weave.

Pure Python stdlib (zlib + struct PNG writer), SDF-based anti-aliasing.
Run from the icons/ directory:  python3 make_icons.py
"""
import math
import struct
import zlib

TEAL_A = (10, 122, 112)     # deep teal
TEAL_B = (34, 211, 238)     # cyan  #22D3EE
CORAL_A = (234, 88, 12)     # deep coral #EA580C
CORAL_B = (251, 191, 36)    # amber #FBBF24


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
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    if L2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / L2))
    return math.hypot(px - (ax + vx * t), py - (ay + vy * t))


def draw(size):
    s = float(size)
    # Diagonal axis, lower-left → upper-right.
    ux, uy = math.cos(math.radians(-45)), math.sin(math.radians(-45))
    cx, cy = s * 0.5, s * 0.5

    # Link geometry (fractions of size, tuned for legibility down to 16px).
    off = s * 0.155          # each link center's offset from the middle
    half = s * 0.075         # half-length of the capsule centerline
    R = s * 0.165            # ring radius (centerline of the band)
    w = s * 0.115            # band thickness
    gap = max(1.0, s * 0.035)  # cut gap around the front link

    def link_sdf(px, py, ccx, ccy):
        """Signed distance to the link band (<=0 inside)."""
        ax, ay = ccx - ux * half, ccy - uy * half
        bx, by = ccx + ux * half, ccy + uy * half
        return abs(dist_to_segment(px, py, ax, ay, bx, by) - R) - w / 2

    # back link lower-left, front link upper-right
    c1 = (cx - ux * off, cy - uy * off)
    c2 = (cx + ux * off, cy + uy * off)

    def coverage(sdf):
        return max(0.0, min(1.0, 0.5 - sdf))

    rows = []
    for j in range(size):
        row = []
        for i in range(size):
            x, y = i + 0.5, j + 0.5
            d_back = link_sdf(x, y, *c1)
            d_front = link_sdf(x, y, *c2)

            a_front = coverage(d_front)
            # back link is cut where the (dilated) front link passes
            a_back = coverage(d_back) * (1.0 - coverage(d_front - gap))

            # gradients run along the diagonal axis
            t = ((x - cx) * ux + (y - cy) * uy) / s + 0.5
            back_col = lerp(TEAL_A, TEAL_B, t)
            front_col = lerp(CORAL_A, CORAL_B, t)

            # composite: front over back over transparent
            a = a_front + a_back * (1 - a_front)
            if a <= 0.003:
                row.append((0, 0, 0, 0))
                continue
            r = (front_col[0] * a_front + back_col[0] * a_back * (1 - a_front)) / a
            g = (front_col[1] * a_front + back_col[1] * a_back * (1 - a_front)) / a
            b = (front_col[2] * a_front + back_col[2] * a_back * (1 - a_front)) / a
            row.append((round(r), round(g), round(b), round(255 * a)))
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
