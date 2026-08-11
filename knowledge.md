# Project knowledge

This file gives Freebuff context about your project: goals, commands, conventions, and gotchas.

## What this is

**Triangle Downloader** — a Chrome extension (Manifest V3) that adds a ▽ button into the
YouTube player and lets users download the current video (720p–2160p `.mp4`, depending on
availability — long videos can be split into ~15-min parts), audio (`.mp3`),
and subtitles (`.txt`), plus select a start–end fragment. It works by capturing the player's
own decrypted MSE stream locally — no `yt-dlp`, no external servers. UI strings and user-facing
errors are in **Russian**; code comments are in English. Docs: `README.md` (ru) / `README.en.md`.

## Quickstart
- **No build system**: plain vanilla JS, no npm, no `package.json` (it's gitignored), no tests, no linters.
- **Setup / Dev**: edit files, then load unpacked from `chrome://extensions` → Developer mode →
  **Load unpacked** → select the **`extension/`** folder. Reload the extension after edits
  (and refresh the YouTube tab for `content_hook.js` changes).
- **Test**: `node --test tests/` — node:test suite (Node 18+, zero deps) for the pure
  helpers in `extension/lib/format.js` (time/trim matrix/base64/run cascade). No linter or
  build step.
- **Debug**: `DEBUG` flag at the top of `content_hook.js` (off by default) re-enables the
  `[YTDL]` diagnostics that were used to chase the quality/capture issues.

## Architecture

All code lives in `extension/`. The extension is split into three contexts communicating over
`chrome.runtime` messages:

- **`manifest.json`** — MV3; permissions `downloads`, `offscreen`, `storage`; host permission
  `*://www.youtube.com/*`; CSP allows `'wasm-unsafe-eval'` (needed by ffmpeg.wasm).
- **`content_hook.js`** — runs in the **MAIN world** at `document_start`, before the player.
  Patches `MediaSource.isTypeSupported` / `canPlayType` / `mediaCapabilities.decodingInfo` to
  make AV1 look unsupported (bundled ffmpeg core can't decode it, so the player serves VP9);
  patches `SourceBuffer.appendBuffer` to concatenate every appended byte per track (video/audio
  classified by MIME). Drives capture by seek-hopping to the buffered edge (no fast playback),
  turns off YouTube autoplay, and reads subtitles from the built-in transcript panel (both the
  legacy and the modern "В этом видео" UIs — keyed off content selectors, never panel ids).
- **`content_ui.js`** — **ISOLATED world**. Renders the ▽ button + menu in
  `.ytp-right-controls`, talks to the hook via `window.postMessage`, streams captured tracks to
  ffmpeg, shows a progress toast, and triggers `chrome.downloads` saves.
- **`background.js`** — service worker. Owns the offscreen-document lifecycle
  (`ytdl-ensure`) and performs the final `chrome.downloads.download` (`ytdl-save`). Cannot run
  ffmpeg itself (no DOM/Worker in a SW).
- **`offscreen.js`** — runs **ffmpeg.wasm** in `offscreen.html`. Receives tracks in base64
  chunks, assembles the final file: fast `-c copy` remux (VP9/Opus into mp4/webm), H.264/AAC
  re-encode, or mp3 (libmp3lame). Tries a cascade of ffmpeg run variants, keeps the first
  non-empty result.
- **`lib/format.js`** — shared PURE helpers (time/trim/base64/filenames/ffmpeg run
  cascade), registered as `globalThis.YTDL_LIB`. Injected by the manifest before
  `content_ui.js` (ISOLATED world) and by `offscreen.html` before `offscreen.js`; also
  `require()`d by `tests/format.test.js` — same code in prod and tests.
- **`content_ui.css`** — player button, menu, toast styles.
- **`extension/vendor/ffmpeg/`** — bundled ffmpeg.wasm builds (`@ffmpeg/ffmpeg@0.12.10`,
  `@ffmpeg/core@0.12.6`, single-threaded, no cross-origin isolation needed). `ffmpeg-core.wasm`
  is referenced at runtime by `offscreen.js`.

### Message protocol (the backbone — keep it consistent)

- **content_ui ↔ content_hook**: `window.postMessage` with flags
  `__ytdl_to_hook: true` / `__ytdl_from_hook: true` and a `reqId`; commands `info`,
  `download` (with `height`, `format`, `start`, `end`), `subtitles`.
- **content_ui ↔ offscreen (via background)**: `chrome.runtime.sendMessage` types:
  - `ytdl-ensure` → background creates the offscreen document.
  - `ytdl-ping` → offscreen liveness probe (SW's `createDocument()` resolves before the
    document is actually listening — always ping before streaming).
  - `ytdl-begin` → resets accumulators, sets mime/format/trim params, warms up ffmpeg.
  - `ytdl-chunk` → one track chunk; payload is base64, `track` in `video|audio`, `seq`-numbered
    (receiver drops duplicates, fails loudly on gaps).
  - `ytdl-finalize` → run ffmpeg, reply with `{ ok, filename }`.
  - `ytdl-progress` → offscreen→content_ui ffmpeg progress event.
  - `ytdl-save` → content_ui/offscreen → background → `chrome.downloads.download`.
  - `ytdl-mem` → content_ui → background → `chrome.system.memory.getInfo()` (capacity /
    free MB) — feeds the adaptive large-capture warning; falls back to
    `navigator.deviceMemory` (capped at 8 GB) if unavailable.

## Conventions

- Plain ES2017+ JS, 2-space indent, `// ---- section ----` banner comments.
- UI labels, user-facing errors, and thrown errors are **Russian**; code comments are English.
- **Never use `innerHTML`** — YouTube pages enforce Trusted Types. Build DOM with
  `createElement` / `textContent` (see `el()` helper in `content_ui.js`).
- All patches/player interactions wrapped in `try/catch` — never break playback.
- No third-party libs beyond the bundled ffmpeg.wasm; no new runtime deps without updating
  `vendor/ffmpeg/` and the CSP.

## Gotchas

- **Trim offsets are RELATIVE to the captured file**, not the video's absolute timeline:
  `-ss` counts from the captured file's own start. `content_hook.js` returns `capturedFrom`
  (segment boundary ≤ requested start) and `content_ui.js` computes
  `trimStart = start - capturedFrom`. Passing an absolute position produced an **empty file**.
- **Exact cuts ≤ 60s** (`EXACT_CUT_MAX_SEC` in `content_ui.js`) get a re-encode; longer
  fragments are stream-copied and start at the keyframe *before* the requested point (a note is
  shown in the toast). The copy path always uses `-avoid_negative_ts make_zero`.
- **Resolution verification**: the modern ABR player can silently serve a lower resolution
  even when `setPlaybackQualityRange('hd2160','hd2160')` is called. For high-res targets
  (`RES_H[target] > 700`, i.e. 1440p/2160p) `playthrough()` selects the quality through the
  **native settings menu** (`menuSetQuality` — opens the gear, picks the exact "Np" entry,
  closes it on every exit path; the same path the user clicks manually, which the user
  confirmed works), then polls `video.videoHeight` against `RES_H` thresholds (up to ~16 s)
  — ALL **before** recording starts, because re-applying quality DURING capture would
  re-init the SourceBuffer and cut the track.
- **NEVER call the JS quality API after a successful menu selection** — this is the #1
  high-res gotcha, confirmed live: `setPlaybackQualityRange` switches the player to AUTO
  (range) mode, which overrides the manual menu choice (ABR serves viewport-capped 720p)
  and keeps re-adjusting quality during capture (each switch re-inits the SourceBuffer and
  CUTS the recorded track → `complete:false`). So `setQualityRaw(targetQ)` is called ONLY
  when `menuSetQuality` returned false, and the verify loop never re-applies the API when
  the menu succeeded. Diagnostics: `[YTDL] quality {menuOk, before, after}` logs
  `getPlaybackQuality()` before/after.
  NO player layout is touched (no theater mode — `setTheaterModeRequested` toggles instead
  of setting, and it broke the user's wide layout). The download reply carries the
  actually-served `height`; `content_ui.js` names the file after the real resolution and
  toasts "плеер отдал Np вместо Mp" when downgraded.
- **Capture loop must use PER-TRACK buffered edges, never the union**: `video.buffered` is the
  union across SourceBuffers, and at high bitrates the audio buffer extends far beyond the
  video one — the union edge would "complete" a capture whose VIDEO track is only a few
  seconds long (symptom: the file freezes on the last decoded frame and is tiny).
  `content_hook.js` stores the latest SourceBuffer per kind in `store.sb` and drives hops and
  completion off `trackEdge()` per track; completion requires BOTH raw edges to reach the end.
- **Mid-capture re-init CUTS the track**: a fresh init while recording replaces that track
  (`store.restarts` counter, counted only when the track already had data). Any restart ⇒
  `complete:false`, so the UI warns "во время захвата переключилось качество".
- **Conflicting extensions can force-reset the quality (known external cause, confirmed
  live)**: "YouTube Auto HD + FPS" and similar quality-forcing extensions keep calling the
  player's quality API, switching it back to AUTO/range mode and OVERRIDING our native-menu
  selection mid-capture. Symptoms: `[YTDL] quality {menuOk: true, after: 'hd1440'}` but the
  capture logs `servedH: 720` and `complete: false` with `restarts` climbing (every external
  reset re-inits the SourceBuffer and CUTS the track). The honest toasts ("плеер отдал Np
  вместо Mp", "файл обрезан") are the correct detection signal — ask the user to disable
  such extensions when high-res captures keep downgrading despite a working menu selection.
- **User must run an ad blocker (uBlock Origin)** — without it YouTube injects ad breaks into
  the media stream and capture fails. This is stated in the README as a hard requirement.
- **Never retry `ytdl-finalize`** — a repeated finalize re-runs ffmpeg on already-freed data.
  Chunk sends are retried once (SW may have been asleep); finalize is not.
- `background.js` is a service worker — it can go to sleep; `content_ui.js` sends
  `ytdl-ensure` and pings before every transfer.
- **Parts feature**: the menu toggle «По частям» (`chrome.storage.local` key `parts`) splits
  ranges longer than `PART_MAX_SEC` (15 min) into sequential independent downloads named
  `(part N of M)`. The adaptive warning (`adaptiveWarning` in content_ui.js) estimates
  capture size (EST_MBPS × seconds × PEAK_MULT ≈ 4× RAM peak) and compares it against 25%
  of real free RAM; it offers parts / whole / cancel via a DOM modal (Trusted Types-safe).
  Constants: `PART_MAX_SEC`, `PEAK_MULT`, `WARN_FRACTION`, `MIN_EST_MB` in content_ui.js.
- Capture is seek-driven and works only while `vidId()` matches (aborts if the user navigates
  to another video); it only runs on `youtube.com/watch` pages.
- Transcoding (H.264, mp3) is single-threaded ffmpeg.wasm — can take minutes on long videos.
