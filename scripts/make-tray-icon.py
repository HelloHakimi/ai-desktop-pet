#!/usr/bin/env python3
"""生成 macOS 托盘图标（爪印）。

托盘图标是纯几何图形，与其塞一个来路不明的二进制进仓库，不如用脚本画出来：
- 4 倍超采样后降采样，得到干净的抗锯齿边缘
- 输出黑色 + alpha 的 Template 图，macOS 会按菜单栏明暗自动反色

用法：python3 scripts/make-tray-icon.py
输出：resources/trayTemplate.png (16x16)、resources/trayTemplate@2x.png (32x32)
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "resources"

SIZE_2X = 32  # @2x 尺寸；1x 由它降采样得到
SS = 4  # 超采样倍数

# 掌垫（椭圆）与四个脚趾（圆），坐标基于 32x32 设计稿
PAD = (16.0, 21.5, 7.6, 6.2)
TOES = [
    (6.6, 10.4, 3.3),
    (12.9, 6.4, 3.5),
    (19.5, 6.4, 3.5),
    (25.6, 10.4, 3.3),
]


def inside(x: float, y: float) -> bool:
    """点（设计稿坐标系）是否落在爪印内部"""
    px, py, rx, ry = PAD
    dx = (x - px) / rx
    dy = (y - py) / ry
    if dx * dx + dy * dy <= 1.0:
        return True
    return any((x - cx) ** 2 + (y - cy) ** 2 <= r * r for cx, cy, r in TOES)


def render_alpha(size: int) -> bytearray:
    """返回 size*size 的 alpha 通道（超采样求覆盖率）"""
    alpha = bytearray(size * size)
    for oy in range(size):
        for ox in range(size):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = ox + (sx + 0.5) / SS
                    y = oy + (sy + 0.5) / SS
                    if inside(x, y):
                        hits += 1
            alpha[oy * size + ox] = round(255 * hits / (SS * SS))
    return alpha


def downsample(alpha: bytearray, size: int) -> bytearray:
    """2x2 盒式降采样，得到一半尺寸的 alpha"""
    half = size // 2
    out = bytearray(half * half)
    for y in range(half):
        for x in range(half):
            total = 0
            for dy in (0, 1):
                for dx in (0, 1):
                    total += alpha[(y * 2 + dy) * size + (x * 2 + dx)]
            out[y * half + x] = round(total / 4)
    return out


def to_rgba(alpha: bytearray, size: int) -> bytes:
    """黑色 + alpha：Template 图只用 alpha 通道表达形状"""
    rgba = bytearray(size * size * 4)
    for i, value in enumerate(alpha):
        offset = i * 4
        rgba[offset + 3] = value
    return bytes(rgba)


def write_png(path: Path, size: int, pixels: bytes) -> None:
    """最小 PNG 编码器：RGBA8、无滤波"""
    raw = b"".join(b"\x00" + pixels[y * size * 4 : (y + 1) * size * 4] for y in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    alpha_2x = render_alpha(SIZE_2X)
    write_png(OUT_DIR / "trayTemplate@2x.png", SIZE_2X, to_rgba(alpha_2x, SIZE_2X))

    alpha_1x = downsample(alpha_2x, SIZE_2X)
    write_png(OUT_DIR / "trayTemplate.png", SIZE_2X // 2, to_rgba(alpha_1x, SIZE_2X // 2))

    for name in ("trayTemplate.png", "trayTemplate@2x.png"):
        path = OUT_DIR / name
        print(f"已生成 {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
