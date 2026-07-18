# Triangle Downloader

[Русский](README.md) · **English**

A Chrome extension (Manifest V3) that adds a ▽ button right into the YouTube player and lets
you download the current video, audio, and subtitles — by capturing the player's own stream.
No `yt-dlp`, no third‑party sites or servers: everything runs locally in your browser.

![Triangle Downloader menu screenshot](docs/screenshot.png)

## Features

- **Video** — 720p / 1080p as `.mp4` (video + audio).
- **Audio** — `.mp3` (audio track only).
- **Clip selection** — "start — end" fields in the menu (default `0:00:00` … full length).
  Only the selected range is downloaded.
- **Subtitles** — `.txt` without timecodes. Prefers Russian, otherwise any available language.
- **Video format** — "Fast" (VP9 in mp4, no re‑encoding, seconds) or "H.264" (re‑encode for
  compatibility with older players, slow).
- **Auto‑disables Autoplay** — the extension turns off YouTube's "Autoplay next" so the next
  video won't start on its own.

## ⚠️ Requirements

- **Google Chrome** (or a Chromium browser) with Manifest V3 support.
- **An ad blocker enabled** (e.g. [uBlock Origin](https://ublockorigin.com/)). This matters:
  without it, YouTube injects ad breaks directly into the media stream, which can make capture
  unstable or cause it to abort.

## Installation

1. Download this repository (**Code → Download ZIP**) and unzip it, or `git clone`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top‑right toggle).
4. Click **Load unpacked** and select the **`extension/`** folder.
5. Open any video on `youtube.com` — a ▽ button (**Triangle Downloader**) appears in the
   right‑hand player controls.

## Usage

1. Click the ▽ button in the player to open the menu.
2. Optionally set the **start** and **end** of a clip (defaults to the whole video).
3. Choose what to download:
   - **Video** → `1080p` or `720p`;
   - **Audio** → `MP3`;
   - **Subtitles** → `.txt`.
4. For video you can switch the **Format**: "Fast" (default) or "H.264".
5. Progress is shown in a toast; the finished file is saved via the browser's normal download.

## How it works

On the web, YouTube no longer serves HD as a single file — it uses the **SABR** protocol:
video and audio arrive as separate encrypted streams that the player decrypts and stitches
together in memory via Media Source Extensions. There is no ready‑made file URL, so the
extension hooks in where the data has already been decrypted and split into tracks:

1. **content_hook.js** (runs before the player) captures media segments at
   `SourceBuffer.appendBuffer`. So the bundled `ffmpeg.wasm` can process them, the player is
   steered toward the **VP9** codec (it cannot decode AV1).
2. To download, the extension locks the desired quality and **seeks to the edge of the buffered
   region** until it has collected every segment of the selected range (no fast playback — gentle
   on YouTube).
3. **offscreen.js** runs `ffmpeg.wasm` and assembles the final file (by default a fast `-c copy`
   remux; for `.mp3` and "H.264" it re‑encodes).
4. **Subtitles** are read from the built‑in "Show transcript" panel (the text is already
   rendered into the DOM), so no tokens or network interception are needed.

## Limitations

- Capture works by seeking through the buffer, so for very long videos it takes time
  proportional to the length.
- "H.264" and `.mp3` re‑encode via `ffmpeg.wasm` (single‑threaded), which is noticeably slower
  than the fast remux — up to a few minutes on long videos.
- In "Fast" mode the `.mp4` contains VP9/Opus codecs — it plays in Chrome, VLC and modern
  players; for older players use "H.264".
- Works on `youtube.com/watch` pages.

## Third‑party components

`extension/vendor/ffmpeg/` contains builds of
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm): the npm packages
`@ffmpeg/ffmpeg@0.12.10` and `@ffmpeg/core@0.12.6` (single‑threaded build, no cross‑origin
isolation required).

## License

This project is licensed under the **GNU General Public License v3.0** — see the
[LICENSE](LICENSE) file.

## Authors

- **Black Triangle** — project author and owner.
- **Claude** (Anthropic) — code development.
