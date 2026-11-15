"""앱 아이콘 원본(1024x1024 PNG)을 생성한다. 외부 라이브러리 없이 zlib 만 사용.
생성 후 `npx tauri icon app-icon.png` 로 플랫폼별 아이콘을 만든다."""
import struct
import sys
import zlib

S = 1024
R = 180  # 모서리 반경
BG = (2, 6, 23, 255)
# (x, y, w, h, color) - 0..1000 좌표의 트리맵 블록
BLOCKS = [
    (90, 90, 470, 560, (59, 130, 246)),
    (580, 90, 344, 300, (168, 85, 247)),
    (580, 410, 344, 240, (245, 158, 11)),
    (90, 670, 270, 254, (16, 185, 129)),
    (380, 670, 180, 254, (239, 68, 68)),
    (580, 670, 160, 254, (20, 184, 166)),
    (760, 670, 164, 117, (100, 116, 139)),
    (760, 807, 164, 117, (34, 197, 94)),
]


def inside_round(x, y):
    cx = min(max(x, R), S - 1 - R)
    cy = min(max(y, R), S - 1 - R)
    return (x - cx) ** 2 + (y - cy) ** 2 <= R * R


def main(out):
    sc = S / 1024
    rows = []
    for y in range(S):
        row = bytearray(S * 4)
        for x in range(S):
            if not inside_round(x, y):
                continue
            px = BG
            for bx, by, bw, bh, col in BLOCKS:
                x0, y0 = (bx + 12) * sc, (by + 12) * sc
                x1, y1 = (bx + bw + 12) * sc, (by + bh + 12) * sc
                if x0 <= x < x1 and y0 <= y < y1:
                    # 쿠션 음영: 좌상단 밝게, 우하단 어둡게
                    t = ((x - x0) / (x1 - x0) + (y - y0) / (y1 - y0)) / 2
                    f = 1.18 - 0.45 * t
                    px = tuple(min(255, int(c * f)) for c in col) + (255,)
                    break
            i = x * 4
            row[i:i + 4] = bytes(px)
        rows.append(b"\x00" + bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(out, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    main(sys.argv[1])
