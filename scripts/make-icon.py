#!/usr/bin/env python3
"""ピクセル調アプリアイコン生成（依存なし・純 Python）。
32×32 のドット絵を最近傍補間で各サイズへ拡大し、macOS iconset 用 PNG と 1024px PNG を書き出す。
  python3 scripts/make-icon.py <outDir> [accentHex]
"""
import struct, sys, zlib, os

out_dir = sys.argv[1]
accent = sys.argv[2] if len(sys.argv) > 2 else '5fe0ff'
os.makedirs(out_dir, exist_ok=True)

N = 32
BLACK = (0, 0, 0, 255)
FRAME = tuple(int(accent[i:i+2], 16) for i in (0, 2, 4)) + (255,)
NOTE = (255, 255, 255, 255)
HILITE = (255, 255, 0, 255)
grid = [[BLACK for _ in range(N)] for _ in range(N)]

def put(x, y, c):
    if 0 <= x < N and 0 <= y < N:
        grid[y][x] = c

# メインアプリのアイコンと同じ「迷路の壁」: 外周（inset 0）と内側（inset 2）の二重線
for inset in (0, 2):
    lo, hi = inset, N - 1 - inset
    for i in range(lo, hi + 1):
        for (x, y) in ((i, lo), (i, hi), (lo, i), (hi, i)):
            put(x, y, FRAME)
# 黄色いペレット（下の飾り）
for x in (6, 10, 14, 18, 22, 26):
    put(x, 28, (255, 255, 0, 255))

# 音符（八分音符）: 符幹・符尾・符頭
for y in range(7, 23):
    put(18, y, NOTE); put(19, y, NOTE)
flag = [(20, 7), (21, 7), (22, 8), (23, 9), (23, 10), (24, 11), (24, 12), (23, 13), (23, 14), (22, 15),
        (20, 8), (21, 8), (22, 9), (22, 10), (23, 11), (23, 12), (22, 13), (22, 14), (21, 15)]
for (x, y) in flag:
    put(x, y, NOTE)
cx, cy, rx, ry = 15.0, 22.5, 4.6, 3.1
for y in range(18, 27):
    for x in range(8, 22):
        xs = x - 0.45 * (y - cy)
        if ((xs - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
            put(x, y, NOTE)
for (x, y) in ((12, 20), (13, 20), (18, 7)):
    put(x, y, HILITE)

def png_bytes(size):
    scale = size / N
    rows = []
    for py in range(size):
        sy = min(N - 1, int(py / scale))
        row = bytearray([0])
        for px in range(size):
            sx = min(N - 1, int(px / scale))
            row += bytes(grid[sy][sx])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

iconset = os.path.join(out_dir, 'icon.iconset')
os.makedirs(iconset, exist_ok=True)
for base in (16, 32, 128, 256, 512):
    with open(os.path.join(iconset, f'icon_{base}x{base}.png'), 'wb') as f:
        f.write(png_bytes(base))
    with open(os.path.join(iconset, f'icon_{base}x{base}@2x.png'), 'wb') as f:
        f.write(png_bytes(base * 2))
with open(os.path.join(out_dir, 'icon.png'), 'wb') as f:
    f.write(png_bytes(1024))
print('written', out_dir)
