"""
把 assets/pet/*.webm 转成 GitHub README 能直接播放的**动图 GIF**，并顺手把静态图缩到合适尺寸。

为什么用 GIF 而不是 <video>：
  GitHub 的 README 会过一遍 HTML sanitizer，`<video>` / `<source>` 被过滤掉，
  贴上去只剩空白。动图 GIF 是 README 里唯一"会自己动"的可靠形式（所有渲染器都支持）。

为什么必须合成背景：
  GIF 只支持 **1 bit 透明**（要么全透要么全不透），直接转会让 alpha 边缘变成硬锯齿 + 黑边。
  所以统一铺一层暖白底色（和角色配色一致），当作一张小卡片 —— 在浅色/深色主题下都自然。

尺寸取舍：
  README 里图片按原始像素显示，太大会铺满页面。这里统一 180px 宽、10fps、约 2.2 秒，
  单张压到 ~100-250KB，六张合计不超过 1.5MB。
"""

import os
import subprocess
import sys

from imageio_ffmpeg import get_ffmpeg_exe

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

PKG = r"E:\DSWork\dsh-cook-pet"
SRC = os.path.join(PKG, "assets", "pet")
OUT = os.path.join(PKG, "docs", "images")

# 背景色：暖白（#F7F2EA），与角色（米白帽 / 红围裙 / 棕发）搭配不抢眼
BG = "0xF7F2EA"
W = 180          # 输出宽度（px）
FPS = 10
SECONDS = 2.2    # 每张动图时长；太长会让体积暴涨
COLORS = 96      # 调色板色数：再高对 Q 版色块收益很小，体积却线性涨

# 各段从第几秒开始截（避开片头的静止/过渡帧，直接给"有动作"的一段）
START = {
    "idle": 0.5,
    "cook": 1.5,
    "serve": 0.3,
    "think": 0.5,
    "wink": 0.1,
    "spin": 0.6,
}


def make_gif(name):
    src = os.path.join(SRC, name + ".webm")
    dst = os.path.join(OUT, name + ".gif")
    if not os.path.exists(src):
        print("  跳过（找不到）:", src)
        return None

    # filter_complex：先按帧率/尺寸缩放前景，再叠到纯色背景上，最后统一调色板
    fc = (
        f"[0:v]fps={FPS},scale={W}:-1:flags=lanczos,format=rgba[fg];"
        f"color=c={BG}:s={W}x{W}:r={FPS}[bg];"
        f"[bg][fg]overlay=shortest=1:format=auto,format=rgb24,"
        f"split[a][b];[a]palettegen=max_colors={COLORS}:stats_mode=diff[p];"
        f"[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"
    )
    cmd = [
        get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
        "-ss", str(START.get(name, 0)), "-t", str(SECONDS),
        "-c:v", "libvpx-vp9", "-i", src,
        "-filter_complex", fc,
        "-loop", "0",
        "-f", "gif", dst,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("  失败:", name, (r.stderr or "").strip()[:300])
        return None
    return os.path.getsize(dst)


def main():
    os.makedirs(OUT, exist_ok=True)
    print("生成动图 GIF（%dpx / %dfps / %.1fs）" % (W, FPS, SECONDS))
    total = 0
    for name in ("idle", "cook", "serve", "think", "wink", "spin"):
        size = make_gif(name)
        if size:
            total += size
            print("  ✓ %-6s %6.1f KB" % (name + ".gif", size / 1024))
    print("\n合计 %.2f MB" % (total / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
