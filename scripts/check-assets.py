#!/usr/bin/env python3
"""
透明素材验收（`npm run assets:check`）

为什么需要这个脚本：**"看着是 webm" 和 "真的有 alpha" 是两件事**。
实测踩到的坑：把一个带黑底的 mp4 用某些工具转成 webm，编码器、扩展名、尺寸都对，
唯独 `pix_fmt` 是 `yuv420p`（没有那个 `a`），透明信息在转码时就被丢掉了 ——
播放器里表现为"桌宠背后有一块黑矩形"，但文件本身不报任何错。

第二个坑更阴：**ffmpeg 默认的 `vp9` 解码器解不出 VP9 alpha**（它会告诉你 yuv420p、
RGBA 解出来全 255），于是"检查 alpha"这件事看起来不可能。其实换 `-c:v libvpx-vp9`
就能正确解出 alpha —— 这个脚本就是这么验的。

逐项检查：
  1. 6 段齐全、能解码、宽高**完全一致**（共用一个裁切框，切换动作时人物不会跳位）
  2. 每段都真的有 alpha：既有全透明(0)也有完全不透明(255)，透明面积在合理区间
  3. 四角必须透明（背景真的没了），人物内部必须不透明（没有被误抠成半透明）
  4. 黑锅铲没被误删：人物区域内的深色像素 alpha 仍然很高
  5. 没有"整帧全透明"的坏帧（编码失败时会这样）

用法：
    python scripts/check-assets.py                 # 检查 assets/pet
    python scripts/check-assets.py <目录>
"""

import json
import os
import subprocess
import sys

import cv2
import numpy as np

try:
    from imageio_ffmpeg import get_ffmpeg_exe
except ImportError:  # pragma: no cover - 环境问题，直接说清楚
    print("缺少 imageio_ffmpeg：pip install imageio-ffmpeg（build-assets.py 也依赖它）")
    sys.exit(2)

# Windows 的控制台默认是 GBK：输出里不要用 ✓/✗ 之类的字符（会 UnicodeEncodeError 直接崩），
# 这里再兜一层 errors="replace"，保证脚本永远不会因为"打印不出来"而失败。
try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ASSET_DIR = os.path.join(HERE, "..", "assets", "pet")
CLIPS = ["idle", "cook", "serve", "think", "wink", "spin"]

# 原素材（只在开发机上有；发布包里不含）。用于"颜色是否串了"的回归对比。
SRC_DIR = os.path.join(HERE, "..", "assets", "cook-已抠图")
ZH_NAME = {"idle": "待机", "cook": "颠锅", "serve": "上菜", "think": "托腮", "wink": "wink", "spin": "转圈"}
DEFAULT_CROP = (280, 0, 1003, 720)

# 合理性区间（不是精确阈值，只用来抓"明显坏了"）
MIN_TRANSPARENT_PCT = 30.0  # 人物占画面 15~25%，其余应是透明 → 至少 30%
MAX_TRANSPARENT_PCT = 90.0  # 超过 90% 说明人物也被抠掉了
MIN_OPAQUE_INTERIOR_PCT = 3.0  # 人物内部完全不透明的像素至少占这么多


def read_crop(asset_dir):
    """裁切框优先读 manifest.json（生成时写入），读不到就用实测默认值。"""
    try:
        with open(os.path.join(asset_dir, "manifest.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        c = data.get("crop") or {}
        return (int(c["x0"]), int(c["y0"]), int(c["x1"]), int(c["y1"]))
    except Exception:
        return DEFAULT_CROP


def source_redness(ff, name, out_w, out_h, crop):
    """
    原素材里"人物区域的平均红度(R-B)"，用来对比成品是否把 R/B 搞反了。

    为什么用红度而不是逐像素比：它不依赖几何对齐（裁切/缩放误差不影响结论），
    而角色有珊瑚红围裙，正常时 R-B 明显为正；一旦 R/B 互换就翻成负值 —— 一个数就能判定。
    """
    zh = ZH_NAME.get(name)
    if not zh:
        return None
    path = os.path.join(SRC_DIR, zh + ".mp4")
    if not os.path.exists(path):
        return None
    cap = cv2.VideoCapture(path)
    frame = None
    for _ in range(6):
        ok, frame = cap.read()
        if not ok:
            break
    cap.release()
    if frame is None:
        return None
    x0, y0, x1, y1 = crop
    c = cv2.resize(frame[y0:y1, x0:x1], (out_w, out_h), interpolation=cv2.INTER_AREA)
    m = c.max(axis=2) > 28  # 非黑 = 人物
    if int(m.sum()) < 500:
        return None
    b = float(c[:, :, 0][m].mean())
    r = float(c[:, :, 2][m].mean())
    return r - b



def ffmpeg():
    return get_ffmpeg_exe()


def frame_alpha(ff, path, index):
    """解出第 index 帧的 RGBA（必须显式指定 libvpx-vp9 解码器才有 alpha）。"""
    tmp = os.path.join(os.environ.get("TEMP", "."), "_assetcheck_%d.png" % os.getpid())
    cmd = [
        ff, "-y", "-hide_banner", "-loglevel", "error",
        "-c:v", "libvpx-vp9",
        "-i", path,
        "-vf", "select=eq(n\\,%d)" % index,
        "-frames:v", "1",
        "-pix_fmt", "rgba", tmp,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    try:
        if r.returncode != 0 or not os.path.exists(tmp):
            return None, (r.stderr or "").strip()[:200]
        img = cv2.imread(tmp, cv2.IMREAD_UNCHANGED)
        if img is None or img.ndim != 3 or img.shape[2] != 4:
            return None, "解出的图没有 alpha 通道（多半是 pix_fmt 没带 a）"
        return img, ""
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def probe_stream(ff, path):
    r = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True, errors="replace")
    for line in r.stderr.splitlines():
        if "Stream #0:0" in line:
            return line.strip()
    return "?"


def main():
    asset_dir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ASSET_DIR)
    ff = ffmpeg()
    print("素材目录：", asset_dir)
    print("ffmpeg  ：", ff)
    print()

    crop = read_crop(asset_dir)
    problems = []
    sizes = {}
    rows = []

    for name in CLIPS:
        path = os.path.join(asset_dir, name + ".webm")
        if not os.path.exists(path):
            problems.append("缺少素材 %s.webm" % name)
            print("[失败] %-6s 缺失" % name)
            continue

        stream = probe_stream(ff, path)
        img, err = frame_alpha(ff, path, 5)
        if img is None:
            problems.append("%s.webm 无法解出带 alpha 的画面：%s" % (name, err or stream))
            print("[失败] %-6s %s" % (name, err))
            continue

        h, w = img.shape[:2]
        sizes[name] = (w, h)
        a = img[:, :, 3]
        bright = img[:, :, :3].max(axis=2)

        transparent_pct = 100.0 * float((a < 8).mean())
        opaque_pct = 100.0 * float((a > 247).mean())
        corners = [int(a[y, x]) for y, x in [(2, 2), (2, w - 3), (h - 3, 2), (h - 3, w - 3)]]

        # 黑锅铲/深棕描边：画面里很暗但**不透明**的像素有多少。
        # ⚠️ 必须限定在"人物内部"：预乘 alpha 的素材里透明区的 RGB 也是 0，
        #    不腐蚀掉边缘就会把大片透明背景当成"暗部"，算出个毫无意义的平均值。
        person = (a > 200).astype(np.uint8)
        interior_mask = cv2.erode(person, np.ones((5, 5), np.uint8), iterations=1) > 0
        dark_in_person = interior_mask & (bright < 70)
        dark_alpha = float(a[dark_in_person].mean()) if dark_in_person.any() else float("nan")
        dark_px = int(dark_in_person.sum())

        # 人物内部（去掉边缘 4px 后 alpha==255 的面积）
        inner = a[4:-4, 4:-4]
        inner_opaque_pct = 100.0 * float((inner == 255).mean())

        # ★ 通道顺序回归检查（R/B 是否互换）
        # 这里踩过真坑：把 BGR 数据按原顺序塞进标记为 RGBA 的编码管道，
        # 成品的 alpha/尺寸/覆盖率全部正常，唯独红围裙渲染成紫色、棕发变蓝。
        # 只有"和原素材比颜色"能发现 —— 所以这项检查比 alpha 检查更能抓出真 bug。
        # 判据用"红度" R-B：原片人物区域红度明显为正（珊瑚红围裙），
        # 一旦 R/B 互换就变成明显为负。这个判据不依赖几何对齐，稳。
        channel_note = "-"
        red_src = source_redness(ff, name, w, h, crop)
        red_out = None
        person_mask = a > 200
        if person_mask.sum() > 500:
            red_out = float(
                img[:, :, 2][person_mask].astype(np.float32).mean()
                - img[:, :, 0][person_mask].astype(np.float32).mean()
            )
        if red_src is not None and red_out is not None:
            channel_note = "%.0f/%.0f" % (red_src, red_out)

        bad = []
        if max(corners) > 24:
            bad.append("四角不透明（%s）" % corners)
        if transparent_pct < MIN_TRANSPARENT_PCT:
            bad.append("透明面积过小 %.1f%%" % transparent_pct)
        if transparent_pct > MAX_TRANSPARENT_PCT:
            bad.append("透明面积过大 %.1f%%（人物被抠没了？）" % transparent_pct)
        if inner_opaque_pct < MIN_OPAQUE_INTERIOR_PCT:
            bad.append("内部全不透明像素过少 %.1f%%" % inner_opaque_pct)
        if a.max() < 200:
            bad.append("全片偏半透明（alpha 最大只有 %d）" % a.max())
        if dark_px > 50 and dark_alpha < 200:
            bad.append("深色区域被误抠（锅铲/描边 alpha 均值 %.0f，样本 %d 像素）" % (dark_alpha, dark_px))
        if red_src is not None and red_out is not None and red_src > 15 and red_out < -15:
            bad.append(
                "R/B 通道互换（原片红度 %.0f，成品红度 %.0f；红围裙会渲染成紫色）"
                % (red_src, red_out)
            )

        rows.append((name, w, h, os.path.getsize(path) / 1024.0, transparent_pct, opaque_pct,
                     corners, inner_opaque_pct, dark_alpha, channel_note))
        if bad:
            problems.append("%s.webm：%s" % (name, "；".join(bad)))

    # ---- 报告 ----
    print("%-6s %-10s %9s %8s %9s %-16s %9s %9s %s" % (
        "动作", "尺寸", "大小KiB", "透明%", "不透明%", "四角alpha", "内部255%", "暗部alpha", "红度(原/成品)"))
    for (name, w, h, kib, tp, op, corners, inner, dark_a, chan) in rows:
        print("%-6s %-10s %9.0f %8.1f %9.1f %-16s %9.1f %9.0f %s" % (
            name, "%dx%d" % (w, h), kib, tp, op, str(corners), inner, dark_a, chan))

    # 6 段宽高必须一致
    if sizes:
        uniq = set(sizes.values())
        if len(uniq) > 1:
            problems.append("6 段宽高不一致（切换动作会跳位）：%s" % {
                k: "%dx%d" % v for k, v in sizes.items()})

    print()
    if problems:
        print("[失败] %d 项未通过：" % len(problems))
        for p in problems:
            print("   - " + p)
        print("\n提示：若四角不透明 / 透明面积过小，通常是 pix_fmt 用了 yuv420p（缺 alpha），"
              "或转码工具把 alpha 丢了。")
        return 1

    total = sum(r[3] for r in rows)
    print("[通过] 6 段素材全部通过：尺寸一致 %dx%d，alpha 正常，深色区域未被误抠。" % (
        next(iter(sizes.values()))[0], next(iter(sizes.values()))[1]))
    print("  合计 %.1f MiB（会随插件一起发布）" % (total / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
