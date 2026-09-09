#!/usr/bin/env python3
"""ホーム画面用のアイコンPNGを生成する（外部ライブラリ不要）。

    python3 tools/make-icons.py

assets/icon-180.png（iOS）と assets/icon-512.png（Android）を書き出す。
図柄は assets/icon.svg と同じ：濃いインク色の角丸に、紙・罫線・マーカー。
"""
import struct, zlib, os

INK   = (0x23, 0x20, 0x1b)
PAPER = (0xfb, 0xf9, 0xf4)
LINE  = (0xc9, 0xc0, 0xaf)
MARK  = (0x8d, 0xc3, 0xa9)
GREEN = (0x2f, 0x6f, 0x5e)
SS    = 3  # スーパーサンプリング倍率

def rounded(x, y, w, h, r):
    """角丸長方形の内側判定。点を内側の矩形に丸めた距離が半径以下なら内側。"""
    def hit(px, py):
        if not (x <= px < x + w and y <= py < y + h):
            return False
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return hit

def shapes(u):
    """u = 1/100 単位。手前にあるものほど後ろに置く。"""
    return [
        (INK,   rounded(0, 0, 100 * u, 100 * u, 22 * u)),                 # 台紙
        (PAPER, rounded(18 * u, 16 * u, 64 * u, 68 * u, 5 * u)),          # 紙
        (GREEN, rounded(18 * u, 16 * u, 5 * u, 68 * u, 2 * u)),           # 背表紙
        (LINE,  rounded(30 * u, 30 * u, 40 * u, 3 * u, 1 * u)),           # 罫線1
        (MARK,  rounded(30 * u, 44 * u, 30 * u, 6 * u, 2 * u)),           # マーカー
        (LINE,  rounded(30 * u, 58 * u, 40 * u, 3 * u, 1 * u)),           # 罫線2
        (LINE,  rounded(30 * u, 70 * u, 24 * u, 3 * u, 1 * u)),           # 罫線3
    ]

def render(size):
    u = size * SS / 100.0
    layers = shapes(u)
    rows = []
    n = SS * SS
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    px, py = x * SS + sx, y * SS + sy
                    color = None
                    for c, hit in layers:
                        if hit(px, py):
                            color = c
                    if color:
                        r += color[0]; g += color[1]; b += color[2]; a += 255
            if a:  # 台紙の外は透明にする
                covered = a // 255
                row += bytes((r // covered, g // covered, b // covered, a // n))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return b''.join(rows)

def write_png(path, size):
    raw = render(size)
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
    print(f'{path} ({size}x{size}, {len(png)} bytes)')

if __name__ == '__main__':
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
    write_png(os.path.join(here, 'icon-180.png'), 180)
    write_png(os.path.join(here, 'icon-512.png'), 512)
