#!/usr/bin/env python3
"""
把"纯黑底的动作 mp4"转换成**带透明通道的 VP9 WebM**（`npm run assets`）。

════════════════════════════════════════════════════════════════════════════
为什么需要这一步（不能直接把 mp4 改个扩展名）
════════════════════════════════════════════════════════════════════════════
原始素材是 H.264 mp4，**mp4/H.264 没有 alpha 通道**。"抠图"如果只是把背景换成纯黑
再导出，透明信息在文件里是不存在的（实测：四角 RGB=(0,0,0)、逐帧解码 alpha 恒为 255）。
浏览器唯一能可靠渲染透明的组合是 **WebM + VP9 + yuva420p**。

════════════════════════════════════════════════════════════════════════════
四步管线，每一步都对应一个踩过的坑
════════════════════════════════════════════════════════════════════════════
1. **取 alpha**：亮度阈值 + 只保留"与画面四边连通"的纯黑区域当背景。
   坑：`connectedComponents` 的 label 0 = 非候选背景（人物本体），必须先排除；
      不排除的话，画面边缘贴着盘子/蒸汽时整块人物会被当背景删掉
      （实测 serve 覆盖率塌成 0.04%，看起来像"素材坏了"）。

2. **羽化 + 边缘颜色外扩**：
   坑：只把 alpha 羽化（0→255）是不够的 —— 羽化带里的 RGB 还是黑底，
      合成到任何背景上都是一圈脏黑边。实测边缘亮度只有 0.2/255（内部是 175）。
   解法：把人物颜色向外铺满羽化带（edge extend）。实测边缘亮度回到 105/255，
      与内部的差距就是正常的抗锯齿衰减。

3. **统一裁切框**：6 段共用同一个框（全片并集），否则切换动作时人物会跳位。
   本项目的框：原图 x∈[280,1003)、y∈[0,720) → 输出 514×512。

4. **编码**：预乘 alpha → RGBA → VP9 `yuva420p`。
   ★ 最大的坑：numpy 里 BGR 和 RGBA 的顺序必须显式转换。写错的表现不是报错，
     而是"红围裙渲染成紫色、棕发变蓝"，而 alpha/尺寸/覆盖率全部正常。
     `scripts/check-assets.py` 的"红度"检查专门守这一条。

依赖：Python 3 + opencv-python + numpy + imageio-ffmpeg（提供 ffmpeg 二进制）。
     scipy 可选：有则用 EDT 一次求出最近实心像素（快且精确），
     没有则退化为多轮邻域复制传播（稍慢，结果接近）。
"""

import json
import os
import subprocess
import sys

import cv2
import numpy as np

try:
    sys.stdout.reconfigure(errors="replace")  # Windows 控制台是 GBK，别因为打印符号崩掉
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
SRC_DIR = os.path.join(PKG, "assets", "cook-已抠图")
OUT_DIR = os.path.join(PKG, "assets", "pet")

# 素材源 → 输出文件名（按**动作语义**命名，不按来源命名：换素材时这套映射不用动）
CLIPS = [
    ("待机", "idle"),
    ("颠锅", "cook"),
    ("上菜", "serve"),
    ("托腮", "think"),
    ("wink", "wink"),
    ("转圈", "spin"),
]

# ---- 可调参数 ----
BG_LUM = 28           # 背景亮度阈值（黑底经 H.264 压缩后有 0~20 的噪声）
FEATHER_SIGMA = 0.9   # 羽化半径 ≈1px
EDGE_EXTEND_PX = 6    # 颜色外扩半径，必须大于羽化带宽（实测 2.62px）
OUT_H = 512           # 输出高度（显示 138px，2x DPI 也够清晰）
CRF = 30              # VP9 质量
CPU_USED = 4          # VP9 速度档（越大越快、质量略降）

# 6 段并集裁切框（原图坐标，右/下开区间）。这是实测值，不是猜的：
# 全 6 段所有帧的"非黑像素"并集 = (286,0,996,719)，四周再留一点余量取整。
# ⚠️ 改了它，桌面窗命中框的比例（lib/electron-helper/renderer.js 顶部常量）要一起改。
CROP = (280, 0, 1003, 720)


def ffmpeg_exe():
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
    except ImportError:
        print("缺少 imageio-ffmpeg：pip install imageio-ffmpeg")
        sys.exit(2)
    return get_ffmpeg_exe()


def key_alpha(frame):
    """单帧 BGR → 0/255 二值 alpha（只把与画面四边连通的纯黑当背景）。"""
    lum = frame.max(axis=2)
    suspect = (lum <= BG_LUM).astype(np.uint8)
    _n, labels = cv2.connectedComponents(suspect, connectivity=4)
    edge_ids = set(int(v) for v in labels[0, :]) | set(int(v) for v in labels[-1, :])
    edge_ids |= set(int(v) for v in labels[:, 0]) | set(int(v) for v in labels[:, -1])
    edge_ids.discard(0)  # ★ label 0 = 人物本体，绝不能当背景
    bg = np.isin(labels, list(edge_ids))
    return np.where(bg, 0, 255).astype(np.uint8)


def feather(a):
    """柔化边界，但人物内部强制回 255（否则整体变半透明、看着发灰）。"""
    soft = cv2.GaussianBlur(a.astype(np.float32), (0, 0), FEATHER_SIGMA)
    interior = cv2.erode((a > 0).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    return np.clip(np.where(interior, 255.0, soft), 0, 255).astype(np.uint8)


def extend_edge_color(bgr, alpha, solid_at=250):
    """
    ★ 边缘颜色外扩：把人物颜色铺满羽化带，消除"半透明 + 黑底"的脏黑边。

    优先用 scipy 的 distance_transform_edt（一次求出"最近实心像素"的坐标，精确）；
    没有 scipy 时退化为多轮 8 邻域**复制**传播（注意是复制不是平均 ——
    平均会被黑底稀释，实测只把边缘亮度从 27.7 提到 67.4，远远不够）。
    """
    solid = alpha >= solid_at
    if not solid.any():
        return bgr.copy()

    try:
        import scipy.ndimage as ndi

        idx = ndi.distance_transform_edt(~solid, return_distances=False, return_indices=True)
        return bgr[idx[0], idx[1]]
    except ImportError:
        out = bgr.copy()
        known = solid.copy()
        k3 = np.ones((3, 3), np.uint8)
        for _ in range(int(EDGE_EXTEND_PX)):
            grown = cv2.dilate(known, k3, iterations=1)
            frontier = (grown == 1) & (known == 0)
            if not frontier.any():
                break
            fill = np.zeros_like(bgr)
            taken = np.zeros_like(known)
            for dy, dx in [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]:
                src_known = np.roll(np.roll(known, dy, axis=0), dx, axis=1)
                src_col = np.roll(np.roll(out, dy, axis=0), dx, axis=1)
                take = frontier & (src_known == 1) & (taken == 0)
                if take.any():
                    fill[take] = src_col[take]
                    taken |= take
            out = np.where(taken[..., None], fill, out)
            known = np.where(taken, 1, known).astype(np.uint8)
        return out


def premultiply(bgr, alpha):
    f = alpha.astype(np.float32) / 255.0
    return np.clip(bgr.astype(np.float32) * f[..., None], 0, 255).astype(np.uint8)


def to_rgba(bgr, alpha):
    """
    ★ BGR + alpha → RGBA（给 ffmpeg 的 -pix_fmt rgba）。

    这里是最容易写错、且**不报错**的一步：直接 dstack(B,G,R,a) 得到的是 BGRA，
    喂给标记为 rgba 的管道就是 R/B 互换 → 红围裙变紫、棕发变蓝。
    check-assets.py 的"红度"检查专门守这一条。
    """
    return np.dstack([bgr[:, :, 2], bgr[:, :, 1], bgr[:, :, 0], alpha])


def decode_all(path):
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    return frames


def encode(rgba_list, out_path, out_w, out_h):
    x0, y0, x1, y1 = CROP
    cmd = [
        ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", "%dx%d" % (x1 - x0, y1 - y0), "-r", "30", "-i", "-",
        "-vf", "scale=%d:%d:flags=lanczos" % (out_w, out_h),
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-b:v", "0", "-crf", str(CRF), "-row-mt", "1", "-cpu-used", str(CPU_USED),
        "-an", "-f", "webm", out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for rgba in rgba_list:
        proc.stdin.write(rgba[y0:y1, x0:x1].tobytes())
    proc.stdin.close()
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError("ffmpeg 编码失败 rc=%d" % rc)


def main():
    if not os.path.isdir(SRC_DIR):
        print("找不到素材源目录：", SRC_DIR)
        print("把 6 段黑底 mp4 按 待机/颠锅/上菜/托腮/wink/转圈 命名放进去。")
        return 2
    os.makedirs(OUT_DIR, exist_ok=True)

    print("ffmpeg :", ffmpeg_exe())
    print("素材源 :", SRC_DIR)
    print("输出   :", OUT_DIR)

    x0, y0, x1, y1 = CROP
    out_w = max(2, round((x1 - x0) * OUT_H / (y1 - y0)))
    print("裁切框 : %s → %dx%d → 输出 %dx%d\n" % (CROP, x1 - x0, y1 - y0, out_w, OUT_H))

    # 先把 6 段全解码（内存换速度：逐段解一遍只需几秒，比反复 seek 快）
    data = {}
    for zh, key in CLIPS:
        path = os.path.join(SRC_DIR, zh + ".mp4")
        if not os.path.exists(path):
            print("缺少素材：%s（对应 %s.webm）" % (path, key))
            return 2
        frames = decode_all(path)
        data[key] = frames
        print("[%s] %-5s %3d 帧 %dx%d" % (key, zh, len(frames), frames[0].shape[1], frames[0].shape[0]))

    print()
    manifest = {
        "generator": "scripts/build-assets.py",
        "crop": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
        "output": {"w": out_w, "h": OUT_H},
        "clips": {},
    }
    total_bytes = 0

    for zh, key in CLIPS:
        frames = data[key]
        rgba_list = []
        for f in frames:
            a = feather(key_alpha(f))
            bgr = extend_edge_color(f, a)
            rgba_list.append(to_rgba(premultiply(bgr, a), a))

        out_path = os.path.join(OUT_DIR, key + ".webm")
        encode(rgba_list, out_path, out_w, OUT_H)
        size = os.path.getsize(out_path)
        total_bytes += size

        a0 = rgba_list[0][:, :, 3]
        h, w = a0.shape
        cov = float(np.mean([float((x[:, :, 3] > 8).mean()) for x in rgba_list[::10]])) * 100
        info = {
            "src_frames": len(frames),
            "size_bytes": size,
            "alpha_coverage": round(cov, 2),
            "corner_alpha": [int(a0[y, x]) for y, x in [(0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1)]],
        }
        # idle 的人物在裁切框内的相对位置（桌面窗命中判定用；比写死比例可靠）
        if key == "idle":
            ys, xs = np.where(a0 > 200)
            if len(xs):
                info["person_in_crop"] = {
                    "left": round(float(xs.min()) / w, 4),
                    "top": round(float(ys.min()) / h, 4),
                    "width": round(float(xs.max() - xs.min() + 1) / w, 4),
                    "height": round(float(ys.max() - ys.min() + 1) / h, 4),
                }
        manifest["clips"][key] = info
        print("[%s] → %5.0f KiB  alpha 覆盖 %4.1f%%  四角 %s" % (key, size / 1024, cov, info["corner_alpha"]))

    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    print("\n合计 %.1f MiB" % (total_bytes / 1024 / 1024))
    print("写出 manifest.json（裁切框 / 每段统计 / 人物在框内的位置）")
    print("\n下一步：python scripts/check-assets.py   # 验收 alpha 与颜色通道")
    return 0


if __name__ == "__main__":
    sys.exit(main())
