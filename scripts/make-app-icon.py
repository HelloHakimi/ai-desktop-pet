#!/usr/bin/env python3
"""生成 macOS 应用图标（圆角方块 + 爪印）并打成 .icns。

为什么用脚本画而不是塞一个二进制进仓库：和托盘图标同理 —— 图标是纯几何图形，
能复现比什么都强。爪印几何与 scripts/make-tray-icon.py 共用同一套设计稿坐标，
所以两处图形是一致的。

只用标准库（struct / zlib），不依赖 Pillow / numpy：这是构建期脚本，
多一个依赖就多一个「换台机器跑不起来」的理由。

用法：python3 scripts/make-app-icon.py
输出：build/icon.icns
"""

from __future__ import annotations

import struct
import subprocess
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "build"
ICONSET = BUILD_DIR / "icon.iconset"
ICNS = BUILD_DIR / "icon.icns"

BASE = 1024  # 先在 1024 上画，其余尺寸由它逐级 2 分降采样（都能整除）
SS = 2  # 超采样倍数。纯 Python 下 SS²·BASE² 就是主要开销，2 已经能给出可接受的边缘

# 圆角方块：macOS 图标不铺满画布，四周留白，圆角半径约为边长的 22.4%
INSET_RATIO = 0.08
CORNER_RATIO = 0.2237

# 爪印（与托盘图标同一套坐标，基于 32x32 设计稿）
PAD = (16.0, 21.5, 7.6, 6.2)
TOES = [
    (6.6, 10.4, 3.3),
    (12.9, 6.4, 3.5),
    (19.5, 6.4, 3.5),
    (25.6, 10.4, 3.3),
]
PAW_BOX = (3.0, 2.6, 29.2, 28.0)  # 爪印在 32 设计稿里占的范围，用来居中
PAW_SPAN = 0.52  # 爪印边长占画布的比例

# 背景渐变（与占位形象同源）+ 爪印颜色
TOP = (0xA8, 0xDC, 0xFF)
BOTTOM = (0x3F, 0x6D, 0xFF)
PAW_COLOR = (0xFF, 0xFF, 0xFF)


def in_squircle(x: float, y: float, space: float) -> bool:
    """点是否落在圆角方块内。space 是当前坐标空间的边长，几何按它等比缩放"""
    inset = space * INSET_RATIO
    half = (space - 2 * inset) / 2
    radius = (space - 2 * inset) * CORNER_RATIO
    dx = abs(x - space / 2) - (half - radius)
    dy = abs(y - space / 2) - (half - radius)
    if dx <= 0 and dy <= 0:
        return True
    dx = max(dx, 0.0)
    dy = max(dy, 0.0)
    return dx * dx + dy * dy <= radius * radius


def make_paw(space: float) -> tuple[float, float, float]:
    """把 32 设计稿的爪印映射到边长 space 的画布，返回 (缩放, x 偏移, y 偏移)"""
    x0, y0, x1, y1 = PAW_BOX
    scale = space * PAW_SPAN / max(x1 - x0, y1 - y0)
    offset_x = space / 2 - (x0 + (x1 - x0) / 2) * scale
    offset_y = space / 2 - (y0 + (y1 - y0) / 2) * scale
    return scale, offset_x, offset_y


def in_paw(x: float, y: float, paw: tuple[float, float, float]) -> bool:
    scale, ox, oy = paw
    px = (x - ox) / scale
    py = (y - oy) / scale
    cx, cy, rx, ry = PAD
    dx = (px - cx) / rx
    dy = (py - cy) / ry
    if dx * dx + dy * dy <= 1.0:
        return True
    return any((px - tx) ** 2 + (py - ty) ** 2 <= r * r for tx, ty, r in TOES)


def render_base() -> bytearray:
    """在 BASE*SS 上超采样渲染，返回 BASE 尺寸的 RGBA"""
    hi = BASE * SS
    space = float(hi)
    paw = make_paw(space)
    step = 1.0 / SS
    samples = SS * SS
    rgba = bytearray(hi * hi * 4)

    for oy in range(hi):
        row = oy * hi * 4
        # 背景渐变按像素中心取值：渐变色本身连续，不需要超采样
        t = (oy + 0.5) / hi
        bg = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        for ox in range(hi):
            hits_bg = 0
            hits_paw = 0
            for sy in range(SS):
                y = oy + (sy + 0.5) * step
                for sx in range(SS):
                    x = ox + (sx + 0.5) * step
                    if in_squircle(x, y, space):
                        hits_bg += 1
                        if in_paw(x, y, paw):
                            hits_paw += 1
            if hits_bg == 0:
                continue
            paw_alpha = hits_paw / samples
            offset = row + ox * 4
            rgba[offset] = round(bg[0] + (PAW_COLOR[0] - bg[0]) * paw_alpha)
            rgba[offset + 1] = round(bg[1] + (PAW_COLOR[1] - bg[1]) * paw_alpha)
            rgba[offset + 2] = round(bg[2] + (PAW_COLOR[2] - bg[2]) * paw_alpha)
            rgba[offset + 3] = round(255 * hits_bg / samples)

    # 超采样图 -> BASE 尺寸
    size = hi
    while size > BASE:
        rgba = downsample(rgba, size)
        size //= 2
    return rgba


def downsample(rgba: bytearray, size: int) -> bytearray:
    """2x2 盒式降采样。alpha 也要一起平均，否则透明边缘会渗出黑边"""
    half = size // 2
    out = bytearray(half * half * 4)
    for y in range(half):
        for x in range(half):
            r = g = b = a = 0
            for dy in (0, 1):
                base = ((y * 2 + dy) * size + x * 2) * 4
                for dx in (0, 1):
                    o = base + dx * 4
                    r += rgba[o]
                    g += rgba[o + 1]
                    b += rgba[o + 2]
                    a += rgba[o + 3]
            o = (y * half + x) * 4
            out[o] = r // 4
            out[o + 1] = g // 4
            out[o + 2] = b // 4
            out[o + 3] = a // 4
    return out


def write_png(path: Path, size: int, pixels: bytes | bytearray) -> None:
    """最小 PNG 编码器：RGBA8、无滤波"""
    raw = b"".join(
        b"\x00" + bytes(pixels[y * size * 4 : (y + 1) * size * 4]) for y in range(size)
    )

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
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    if ICONSET.exists():
        for old in ICONSET.iterdir():
            old.unlink()
    ICONSET.mkdir(parents=True, exist_ok=True)

    print(f"渲染 {BASE}x{BASE}（{SS}x 超采样，纯 Python 需要几十秒）…")
    image = render_base()

    # 逐级 2 分降采样，得到 .iconset 需要的所有尺寸
    cache: dict[int, bytearray] = {BASE: image}
    size = BASE
    while size > 16:
        size //= 2
        cache[size] = downsample(cache[size * 2], size * 2)

    for base_size, name in [
        (16, "icon_16x16.png"),
        (32, "icon_32x32.png"),
        (128, "icon_128x128.png"),
        (256, "icon_256x256.png"),
        (512, "icon_512x512.png"),
    ]:
        write_png(ICONSET / name, base_size, cache[base_size])
        write_png(ICONSET / name.replace(".png", "@2x.png"), base_size * 2, cache[base_size * 2])

    print("调用 iconutil 打包 .icns …")
    result = subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET), "-o", str(ICNS)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("iconutil 失败：" + result.stderr.strip(), file=sys.stderr)
        sys.exit(1)

    # .iconset 是可再生的中间产物，只留 .icns
    for leftover in ICONSET.iterdir():
        leftover.unlink()
    ICONSET.rmdir()

    # 顺手留一张 512 的预览图，方便肉眼确认（不进打包）
    write_png(BUILD_DIR / "icon-preview.png", 512, cache[512])
    print(f"已生成 {ICNS.relative_to(ROOT)}（{ICNS.stat().st_size / 1024:.0f} KB）")


if __name__ == "__main__":
    main()
