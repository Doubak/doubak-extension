#!/usr/bin/env python3
"""生成占位图标。零依赖（只用标准库的 zlib/struct），与项目的工具链约束一致。

    python3 tools/make-icons.py

正式图标的要求见 icons/README.md。
"""

import pathlib
import struct
import zlib

BG = (26, 95, 58)        # 偏深的豆瓣绿
FG = (255, 255, 255)


def render(size: int) -> bytes:
    px = [[BG for _ in range(size)] for _ in range(size)]
    c = size / 2
    r = size * 0.34

    for y in range(size):
        for x in range(size):
            dx, dy = x + 0.5 - c, y + 0.5 - c
            # 上下两颗豆
            for oy in (-r * 0.42, r * 0.42):
                ex, ey = dx / (r * 0.62), (dy - oy) / (r * 0.34)
                if ex * ex + ey * ey <= 1.0:
                    px[y][x] = FG

    raw = b"".join(
        b"\x00" + b"".join(struct.pack("3B", *px[y][x]) for x in range(size))
        for y in range(size)
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    out = pathlib.Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for s in (16, 32, 48, 128):
        (out / f"{s}.png").write_bytes(render(s))
        print(f"icons/{s}.png")
