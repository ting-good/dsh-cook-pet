# Zhaozhao · dsh-cook-pet 🍳

[中文](README.md) | **English**

> A little chef-girl desktop pet living inside [DeepSeek Harness](https://www.deepseek.com/harness/).
> Her name is **Zhaozhao** (照照). When idle she stands around holding a spatula; give her work and she
> **tosses a wok**; when a turn finishes she **brings you a plate of food**; when she
> **needs your approval or an answer, she props her chin on her hand and waits**; poke her and
> she'll wink or spin.

![Zhaozhao, floating on your desktop with a transparent background](docs/images/zhaozhao-240.png)

**Four states (animated — these are the actual on-screen motions):**

| Idle | Cooking | Serving | Waiting |
| :---: | :---: | :---: | :---: |
| ![idle](docs/images/idle.gif) | ![cooking](docs/images/cook.gif) | ![serving](docs/images/serve.gif) | ![waiting](docs/images/think.gif) |
| stands and sways | tosses the wok | brings a plate | tilts her head, waits |

---

## ✨ What she does

| Moment | State | Visual | Text |
| --- | --- | --- | --- |
| No task running | **idle** | stands, spatula in hand | — |
| Turn running (`turn/start`) | **cooking** | tosses the wok | — |
| **Waiting for your approval / answer** | **waiting** | chin on hand, head tilted | **"等你回话"** |
| Turn completed successfully | **serving** | brings a plate, auto-idles after ~5 s | — |
| Turn aborted / errored | quietly idle | **no celebration** | — |
| You click her | **wink or spin** | random pick, then back to current state | — |

> **Only the "waiting" state shows text.** Everything else is pure animation — a desktop pet
> shouldn't have words covering the screen; only "it's your turn" deserves a glance.
>
> One more deliberate rule: **"serving" only appears when the task genuinely succeeded.**
> Interrupted, errored, timed out — she quietly returns to idle. She never gives you a fake
> "done" signal.

### 🤔 What "waiting" actually means

It is not a vague "busy" state. It maps to exactly **two kinds of real waiting**:

| Trigger | Host event |
| --- | --- |
| Permission dialog (a tool needs allow/deny) | `approval/asked` → `approval/decided` |
| Model asks you via `ask_user_question` | `tool/call` → `tool/result` |
| Plan mode hands a plan over for approval (`exit_plan_mode`) | same as above |
| Questions raised inside `run_code` scripts | `tool/ptc-dispatch-start` → `tool/ptc-dispatch` |

These are **paired, durable events**, so both "started waiting" and "you answered" are captured
precisely — no polling, no guessing, and closing the dialog outright cannot leave her stuck
in the waiting state.

---

## 🖱️ Interaction

| Action | Effect |
| --- | --- |
| **Click** | random wink or spin, then back to the current state |
| **Drag** | move her; the position is remembered across reloads |
| **Right-click** | cycle size: 110 / 138 / 190 / 260 px (also remembered) |

| Click · wink | Click · spin |
| :---: | :---: |
| ![wink](docs/images/wink.gif) | ![spin](docs/images/spin.gif) |

---

## 📦 Install

> Requires **DSH ≥ 0.2.0** (tested on 0.2.1-rc.1).

### ⚡ One command (recommended)

```bash
dsh plugin --profile desktop add github:ting-good/dsh-cook-pet
```

Replace `desktop` with the profile you actually boot (`web` if you run `dsh web`). Then **restart DSH**.

This installs from git. The project is **plain JavaScript with no build step**, so no `prepare`
build authorization is needed — it works right after install.

### 🧑‍💻 From a local directory (developers)

```bash
# If dsh isn't on PATH, use the full path, e.g. Windows desktop build:
#   D:\Deepseek\resources\runtime\cli\bin\dsh.cmd
dsh plugin --profile desktop add file:/absolute/path/to/dsh-cook-pet
```

### 🖥️ The floating desktop window: Electron prepares itself (optional)

The always-on-top window is rendered by a separate Electron process and needs an Electron runtime
(the DSH host itself is plain Node and ships no Electron binary).

**You don't have to do anything**: the first time the runtime is missing, the plugin downloads it
**in the background** (~140 MB, once only) and the desktop window appears when it's ready.
DSH is fully usable during the download — she just isn't on screen yet.

The download is built to survive bad networks:

| Capability | Detail |
| --- | --- |
| Mirror fallback | npmmirror → registry.npmmirror → huaweicloud, tried in order |
| Limited retries | 3 attempts per mirror before giving up |
| **Resumable** | continues from the bytes already downloaded (kept in `~/.dsh/electron/.download/`) |
| Stall timeout | aborts an attempt after 60 s without data, instead of hanging forever |

**If every attempt fails**, the DSH log prints copy-paste manual instructions (download URL,
extract directory, pointing at an existing Electron, or disabling the desktop window) —
and the next retry resumes automatically.

| You want to | Do this |
| --- | --- |
| Trigger / retry the download (auto-resumes) | `node scripts/ensure-electron.mjs` |
| Reuse an existing Electron | `DSH_COOK_PET_ELECTRON=<path to electron executable>` |
| Different mirror (used exclusively) | `DSH_COOK_PET_ELECTRON_MIRROR=<mirror url>` |

> Note: deleting `~/.dsh/electron` makes her disappear (the plugin itself keeps running).
> To turn the pet off completely: `DSH_COOK_PET_DESKTOP=0`, or uninstall the plugin.

Then Zhaozhao appears in the **bottom-right corner of your screen** — the screen, not the page,
because she floats above every application. Drag to move, right-click to resize; both persist.

### 🗑️ Uninstall

```bash
dsh plugin --profile desktop remove dsh-cook-pet
```

All overlay nodes, timers and event listeners are torn down on uninstall (guarded by tests).

---

## 🎨 How she was made

The character and all six animation clips are **AI-generated** (Q-style anime, green-screen /
black-background sources), then converted into **transparent video** by a reproducible asset pipeline.

| Step | Technique | Why |
| --- | --- | --- |
| 1. Derive alpha | treat only *pure black connected to the frame border* as background | the black spatula and dark-brown outlines survive |
| 2. Edge colour extension | smear interior colours across the feathered band | otherwise the black background inside the feathered band becomes a dirty dark fringe |
| 3. Shared crop box | one box for all six clips (union) | the character must not jump when the action changes |
| 4. Encode | premultiplied alpha → VP9 `yuva420p` | the only transparent video format browsers handle reliably |

> The most important lesson: **mp4/H.264 has no alpha channel.** A "cut-out mp4" merely has a
> black or green background baked in — the transparency simply isn't in the file. It must be
> re-encoded as `yuva420p` WebM.

The pipeline's pitfalls (all backed by measurements and regression tests) are documented in
[docs/素材管线实测.md](docs/素材管线实测.md) (Chinese).

### 🎨 Want your own character?

**Step 0 (most important): generate the video on a green screen.**

| Background | Consequence |
| --- | --- |
| **Pure green `#00FF00`** ⭐ | Easiest to key: green is far from the character's colours, so the matte is clean and **semi-transparent effects (smoke, glow) survive** |
| Pure black | Works, but **flattens translucent content** — white semi-transparent smoke becomes opaque dark grey and has to be reverse-engineered |
| White / grey / gradient | Hard to key; tends to eat the character's pale parts (white hat, white apron) |

Also put these in the generation prompt: **fixed frontal camera**, **no positional drift**,
**identical first and last frame** (so loops don't jump), **no text or watermark**.
The full prompts for this project's six clips are in
[docs/视频提示词-等待确认.md](docs/视频提示词-等待确认.md) and
[docs/视频提示词-点击回应.md](docs/视频提示词-点击回应.md).

**Step 1: prepare the files**

Name six clips by *what they mean*, and drop them into `assets/cook-已抠图/`:

| File | Played when | Requirement |
| --- | --- | --- |
| `待机.mp4` | no task running | first/last pose identical, loopable |
| `颠锅.mp4` | a turn is running | same |
| `上菜.mp4` | a turn succeeded | plays once |
| `托腮.mp4` | waiting for your approval/answer | first/last pose identical, long-loopable |
| `wink.mp4` | click reply | first/last pose = the idle pose |
| `转圈.mp4` | click reply | same |

> You can also feed it a **per-frame cut-out PNG sequence** (true alpha), like this project's
> final wok and serving clips — best quality, no inference needed. See the read branch in
> `scripts/build-assets.py`.

**Step 2: run the pipeline and verify**

```bash
npm run assets        # writes six transparent WebM files into assets/pet/
npm run assets:check  # verifies: transparent corners / dark regions kept / identical size / channel order
```

**Step 3: the only two places to touch when the framing changes**

| What you changed | Also update |
| --- | --- |
| The crop box (`CROP` at the top of the script) | the hit-box ratio constants at the top of `runtime/electron-helper/renderer.js` |
| The asset content | `ASSET_VERSION` in `renderer.js` (+1, otherwise the desktop window may load a stale file) |

**Step 4: restart DSH**

The desktop window reads assets into memory at startup, so a restart is required for a full swap.

---

## 🗂️ Project structure

```
dsh-cook-pet/
├── 🧩 lib/                      # host side: runs inside the DSH process
│   ├── index.js                 #   entry: listen to events, serve /state & /asset, launch the desktop window
│   ├── state.js                 #   4-state machine (idle / cook / serve / think)
│   ├── waiting.js               #   turns approvals/questions into "waiting"
│   └── desktop.js               #   desktop-window lifecycle (incl. preparing Electron automatically)
│
├── 🖥️ runtime/electron-helper/   # the desktop window: a separate Electron process — what you actually see
│   ├── main.js                  #   transparent · always-on-top · frameless + click-through + right-click resize
│   ├── renderer.js              #   animation playback, hit-testing, dragging
│   └── preload.js               #   IPC bridge between renderer and main
│
├── 🎬 assets/pet/*.webm         # six transparent clips (514×512, VP9 alpha)
├── 🛠️ scripts/                  # asset pipeline, pre-publish checks, Electron setup
└── 📚 docs/                     # detailed docs (not published)
```

**How it runs:**

```
   DSH host process (lib/index.js)
    ├─ listens to session/event → lib/state.js (4 states)
    ├─ listens to approvals/questions → lib/waiting.js ("waiting")
    └─ exposes /dsh-cook-pet/state and /asset/*
                 │  1 s polling
                 ▼
        Electron desktop window (runtime/electron-helper)
        transparent · frameless · floats above all apps
```

> No build step: `lib/*.js` is hand-written plain JS that DSH loads directly.
> There is no in-page version either — Zhaozhao exists only as this always-on-top window,
> so she stays visible even when DSH is minimized.

---

## 🧩 Compatibility

| Item | Status |
| --- | --- |
| DSH | tested on `0.2.0-rc.1` / `0.2.0-rc.2` / `0.2.1-rc.1` / `0.2.1-rc.2` (`engines.dsh: >=0.2.0`) |
| Desktop window | tested on Windows (Electron 43, `transparent + alwaysOnTop`); macOS/Linux untested |
| Node | ≥ 22.12 |

---

## ⚠️ Known limitations

1. **Part of the alpha is inferred**: the sources have no alpha channel. Four clips derive it from a
   black/green background; the wok and serving clips use per-frame cut-out PNG sequences (true alpha).
2. **The serving clip is 30 fps but had 5 frames deleted** (4.73 s → 4.57 s), so a one-frame hiccup is
   theoretically possible.
3. **Asset changes need a restart**: `?v=` busts the cache, but the desktop window reads assets into
   memory at startup.
4. **Click replies are a random 1-of-2**, not position/count based.
5. **No settings page**: size cycles on right-click (110 / 138 / 190 / 260), position by dragging
   (both persisted).
6. **She exists only in the desktop window**: Electron needs a ~100 MB one-time download.
   **There is no in-page version** — if Electron can't start (download blocked, heavily restricted
   environment) you won't see her, but DSH itself is unaffected.

---

## 📜 License

- The character "Zhaozhao" and all six animation clips were generated for this project.
- Code licensed under **MIT** — see [LICENSE](LICENSE).

## 📚 Further docs

| Document | Content |
| --- | --- |
| [docs/素材管线实测.md](docs/素材管线实测.md) | Measured data for the six clips: dimensions, frames, alpha coverage, crop-box derivation |
| [docs/视频提示词-等待确认.md](docs/视频提示词-等待确认.md) | Full generation prompt for the chin-on-hand animation |
| [docs/视频提示词-点击回应.md](docs/视频提示词-点击回应.md) | Full generation prompts for the wink / spin click replies |
