# Audit — Triangle Downloader

Full engineering review performed on **2026-08-11** per `ReviewPrompt.txt`.

## Scope & method

- Reviewed the entire repository: `extension/manifest.json`, `extension/background.js`,
  `extension/offscreen.js`, `extension/content_hook.js`, `extension/content_ui.js`,
  `extension/content_ui.css`, `extension/offscreen.html`, `README.md`, `README.en.md`,
  vendor assets (`extension/vendor/ffmpeg/`), icons.
- Traced the full data flow: **UI (isolated) → hook (MAIN world, MSE capture) →
  transfer (postMessage / runtime messages) → offscreen ffmpeg → downloads**.
- Validation commands run:
  - `node --check` on all 4 JS files → **all pass** (no syntax errors).
  - `extension/vendor/ffmpeg/ffmpeg-core.wasm` and `icons/*.png` referenced by the code are
    present.
  - No tests, linter, or build tooling exists in the repo (none to run).
- **No code was modified** during this review (per ReviewPrompt). All proposed fixes below
  are ready-to-use examples. A git commit was intentionally **not** made: the working tree has
  no tracked modifications (only the untracked `.agents/`, `ReviewPrompt.txt`, `knowledge.md`),
  so there was nothing to commit.

## Findings summary

| # | Severity | File | Issue |
|---|----------|------|-------|
| F1 | **High** | offscreen.js | One ffmpeg load failure bricks all future downloads for the session |
| F2 | **High** | content_hook.js | Incomplete capture (stall / 20-min cap) silently saved as a "successful" file |
| F3 | **Medium** | content_hook.js | Mid-capture SourceBuffer re-init glues two init segments → corrupt track |
| F4 | **Medium** | offscreen.js | Blob URL revoked 60s after save request — large downloads may be cut off |
| F5 | **Medium** | content_hook.js | MAIN-world postMessage bridge has no re-entrancy guard or range validation |
| F6 | **Low** | manifest.json | No `minimum_chrome_version`; `offscreen.hasDocument()` needs Chrome 116+ |
| F7 | **Low** | offscreen.js | `out.length > 1024` rejects legitimately tiny outputs (sub-second/silent clips) |
| F8 | **Low** | content_ui.js | `transcode` read from storage twice; dead `phase` field; minor cleanup |
| F9 | **Info** | all | Memory profile of large captures; no automated tests (recommendation below) |

---

## F1 — ffmpeg load failure permanently bricks all downloads (High)

**Where:** `extension/offscreen.js`, `getFF()`.

**Problem:** `ffLoading` caches the *promise* of the load, not the result. If
`inst.load({...})` rejects once (OOM, transient fetch failure of `ffmpeg-core.wasm`,
corrupted cache), then:

```js
async function getFF() {
  if (ff) return ff;
  if (ffLoading) return ffLoading;   // ← forever returns the rejected promise
  ...
}
```

Every later call — including every future download — returns the same rejected promise, so
**all downloads fail until the extension is reloaded**, with no way to recover.

**Fix:** reset the loading state on failure so the next call retries:

```js
async function getFF() {
  if (ff) return ff;
  if (ffLoading) return ffLoading;
  ffLoading = (async () => {
    const inst = new FFmpeg();
    inst.on('progress', ({ progress }) => {
      try { chrome.runtime.sendMessage({ t: 'ytdl-progress', value: Math.max(0, Math.min(1, progress)) }); } catch (e) {}
    });
    inst.on('log', ({ message }) => {
      ffLog.push(message);
      if (ffLog.length > 40) ffLog.shift();
    });
    const base = chrome.runtime.getURL('vendor/ffmpeg/');
    await inst.load({ coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
    ff = inst;
    return inst;
  })();
  ffLoading = ffLoading.catch((err) => { ffLoading = null; throw err; });
  return ffLoading;
}
```

**Rationale:** `ffLoading` becomes `null` on failure; the current caller still receives the
rejection (so the toast shows the error), but the next attempt rebuilds the instance. This is
a minimal, safe change that only affects the failure path.

---

## F2 — incomplete capture is silently reported as success (High)

**Where:** `extension/content_hook.js`, `playthrough()`.

**Problem:** the capture loop can exit in three ways, but only one is "complete":

```js
if (edge >= capEnd - 0.6) break;                  // complete
if (stall >= 60) break;                           // ~21s without progress → INCOMPLETE
if (Date.now() - started > 20 * 60 * 1000) break; // hard cap → INCOMPLETE
```

After the loop the function returns `{ capturedFrom }` unconditionally, `content_ui.js`
proceeds to mux whatever bytes were captured, and the user gets a "Готово" toast with a
**silently truncated file** — no warning at all. For a very long video where buffering
plateaus, this is a realistic failure mode.

**Fix:** report completeness and surface a warning in the UI. The flag must be threaded
through three hops: `playthrough()` → the hook's reply payload → `content_ui.js`.

In `content_hook.js` `playthrough()`:

```js
let complete = false;
...
while (true) {
  await sleep(350);
  ...
  const edge = bufferedEndAt(cursor);
  onProgress(...);
  if (edge >= capEnd - 0.6) { complete = true; break; }
  ...
}
...
return { capturedFrom: Math.max(0, capturedFrom), complete };
```

In the hook's `download` message handler, add the flag to the reply payload:

```js
const payload = {
  ok: true, done: true,
  complete: !!cap.complete,          // false when capture broke on stall / hard cap
  capturedFrom: cap.capturedFrom,
  audio: { mime: aud.mime, size: aud.bytes.byteLength },
};
```

In `content_ui.js` `startDownload()`, after the capture resolves:

```js
const alignedStart = !isMp3 && needsExactCut && !doTranscode;
const partialNote = result.complete === false ? ' — захват неполный, файл может быть обрезан' : '';
t.set('Готово: ' + (res.filename || filename) +
  (alignedStart ? ' — начало выровнено по опорному кадру' : '') + partialNote, 1);
t.hide(alignedStart || result.complete === false ? 7000 : 4000);
```

**Rationale:** keeping the partial file (rather than aborting) wastes nothing the user didn't
already wait for, but the warning turns a silent corruption into an informed decision. The
`complete` flag is additive and doesn't change capture behaviour.

---

## F3 — mid-capture re-init glues two init segments into one track (Medium)

**Where:** `extension/content_hook.js`, `appendBuffer` patch.

**Problem:** the current code only handles two cases — "new track" and "append to existing":

```js
if (store.capturing) {
  let t = store.tracks[kind];
  if (!t) { /* create from init or seed from lastInit */ }
  else { t.parts.push(u8.slice()); }   // ← also pushes a *new init* if one arrives
}
```

If the player clears its SourceBuffer mid-capture (`remove()` + a fresh init — which happens
after stalls, buffer eviction, or a re-negotiation), the captured track becomes
`init₁ … init₂ …` — two concatenated init segments. ffmpeg fails on that, and every fallback
run in the cascade fails too, so the whole download errors out for no user-understandable
reason.

**Fix:** a fresh init mid-capture means the buffer was restarted, so restart the track at the
new init instead of gluing:

```js
if (store.capturing) {
  let t = store.tracks[kind];
  if (init) {
    // A fresh init mid-capture means the player cleared the buffer and restarted
    // (remove() + new init). Everything before is no longer contiguous — replace the
    // track with the new init instead of producing init₁ + init₂.
    store.tracks[kind] = { mime: this.__ytdlMime || '', parts: [u8.slice()] };
  } else {
    if (!t) {
      if (store.lastInit[kind]) {
        t = store.tracks[kind] = { mime: store.lastInit[kind].mime, parts: [store.lastInit[kind].bytes, u8.slice()] };
      }
    } else {
      t.parts.push(u8.slice());
    }
  }
}
```

(`store.lastInit[kind]` is still updated unconditionally earlier in the function, so
`lastInit` remains fresh for the next capture.)

**Rationale:** a re-init without a preceding `remove()` is essentially unheard-of in MSE
players — init segments are only appended right after `addSourceBuffer`/`remove`. Restarting
loses the pre-re-init bytes, but those were no longer part of the live buffer anyway;
concatenating would guarantee corruption.

---

## F4 — blob URL revoked while a large download may still be reading it (Medium)

**Where:** `extension/offscreen.js`, `finalize()`.

**Problem:**

```js
const res = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename });
setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
```

`chrome.downloads.download` resolves as soon as the download is *initiated*; the browser
process then reads the blob asynchronously. For multi-GB files (or a slow disk) the read can
outlive the 60s timer, and revoking the object URL mid-read can abort the download.

**Fix:** revoke only when the download actually finishes. Have `background.js` listen for
completion and tell the offscreen document to release the URL:

In `background.js`:

```js
if (msg.t === 'ytdl-save') {
  chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
    .then((id) => {
      // The blob must stay alive until the browser finishes reading it.
      chrome.downloads.onChanged.addListener(function onChanged(delta) {
        if (delta.id !== id) return;
        if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
          chrome.downloads.onChanged.removeListener(onChanged);
          chrome.runtime.sendMessage({ t: 'ytdl-revoke', url: msg.url }).catch(() => {});
        }
      });
      sendResponse({ ok: true, id });
    })
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
}
```

In `offscreen.js`:

```js
if (msg.t === 'ytdl-revoke') { try { URL.revokeObjectURL(msg.url); } catch (e) {} sendResponse({ ok: true }); return; }
```

and remove the fixed 60s `setTimeout`. Add a generous hard fallback in case the download
never fires `complete`/`interrupted` (the offscreen document is never closed, so without it
a permanently pending download would leak its blob for the whole session):

```js
// belt-and-braces: guarantee release even if onChanged never fires
setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 10 * 60 * 1000);
```

**Rationale:** ties the blob's lifetime to the download's actual lifetime — the correct
semantics — instead of a guess.

---

## F5 — MAIN-world bridge: no re-entrancy guard, no input validation (Medium)

**Where:** `extension/content_hook.js`, `window` message listener.

**Problem:** the hook runs in the **MAIN world**, so *any* script on the page (an ad, a
sloppy third-party widget, or a compromised embed) can `postMessage` a forged
`{ __ytdl_to_hook: true, cmd: 'download', ... }` and:
- trigger the seek-loop + ffmpeg work (CPU/memory churn) with no bound on the requested range;
- force arbitrary-quality captures repeatedly.

This is inherent to patching MSE in the MAIN world (the hook and page scripts share a world),
so it cannot be fully closed — but the cost of abuse can be drastically lowered.

**Fix (hardening, keep it cheap):**

```js
// in the message handler, before dispatching 'download':
const p = player();
const v = video();
const dur = (v && isFinite(v.duration) && v.duration > 0) ? v.duration : 0;
const h = Number(height), s = Number(start), e = Number(end);
if (cmd === 'download') {
  if (store.capturing) throw new Error('capture already running');   // re-entrancy guard
  if (!dur || !isFinite(s) || !isFinite(e)) throw new Error('invalid range');
  // clamp ranges; never accept out-of-video seeks
  ev.data.start = Math.max(0, Math.min(s, Math.max(0, dur - 1)));
  ev.data.end = Math.max(ev.data.start + 1, Math.min(e, dur));
  if (format !== 'mp3' && !Q[h]) ev.data.height = 'hd720';          // whitelist quality
}
```

And a total-bytes cap inside the capture loop so an abusive request cannot run ffmpeg on
gigabytes:

```js
const totalCaptured = () =>
  (store.tracks.video ? store.tracks.video.parts.reduce((n, p) => n + p.length, 0) : 0) +
  (store.tracks.audio ? store.tracks.audio.parts.reduce((n, p) => n + p.length, 0) : 0);
// in the loop: if (totalCaptured() > 4 * 1024 * 1024 * 1024) break; // ~4 GB guard
```

**Rationale:** the whitelist/range-clamping turns "capture anything" into "capture only valid
video ranges", and the re-entrancy guard prevents stacking concurrent captures. Note in the
code that full protection is impossible in the MAIN world by design.

---

## F6 — missing `minimum_chrome_version` (Low)

**Where:** `extension/manifest.json`.

**Problem:** the extension relies on `chrome.offscreen.hasDocument()` (Chrome **116+**) and the
`offscreen` API (Chrome 109+), but the manifest declares no minimum. On an older browser,
`background.js` throws `TypeError: chrome.offscreen.hasDocument is not a function` and the
whole worker dies.

**Fix:**

```json
"minimum_chrome_version": "116"
```

**Rationale:** makes the requirement explicit at install time instead of failing at runtime.

---

## F7 — non-empty check rejects legitimately small files (Low)

**Where:** `extension/offscreen.js`, `finalize()`.

**Problem:**

```js
if (out && out.length > 1024) { data = out; chosen = run; break; }
```

The `> 1024` heuristic guards against "successful" runs that produced empty output — but it
also discards valid tiny results. A sub-second clip or a nearly-silent MP3 can legitimately be
a few hundred bytes (a single MP3 frame is ~24–417 bytes); those downloads then fail with
"ffmpeg не собрал файл".

**Fix:**

```js
if (out && out.length > 0) { data = out; chosen = run; break; }
```

An exit code of 0 plus a non-empty, readable file is a sufficient success signal here; the
empty-output case is exactly `out.length === 0`. If some additional margin is desired, use a
small floor (e.g. `> 64`) that cannot exclude a valid file.

**Rationale:** the threshold's purpose is detecting empty output, and 0 bytes is the precise
test for that.

---

## F8 — minor cleanup in content_ui.js (Low)

- `transcode` is read from `chrome.storage.local` twice (`onClick` and `startDownload`).
  Since `startDownload` is only reachable from the menu, pass it through: read once in
  `onClick` and thread it into `startDownload(opts, info, transcode)`. Removes a redundant
  async hop.
- The hook's progress replies carry `phase: 'buffering'`, but `download()` in `content_ui.js`
  only uses `progress`. Either use `phase` for future-proofing or drop it.
- `callHook('info')` never resolves if the hook failed to install (page race). If the menu
  does not open, the user gets no feedback. Consider a timeout that shows an error toast
  ("не удалось связаться с плеером") instead of hanging silently.

---

## F9 — memory profile & test strategy (Info / recommendation)

**Memory:** the pipeline holds the tracks in RAM several times over: full track buffers in the
hook (transferred, then detached), base64 strings in `content_ui.js` (4 MB chunks, bounded),
and the accumulated track plus the final file in the offscreen document (unbounded). A long
1080p capture can be hundreds of MB–GBs. This is inherent to the design (MSE capture +
ffmpeg.wasm in-page) and acceptable for a personal downloader, but the offscreen document is
also **never closed**, so ffmpeg (~tens of MB of WASM) and any accumulated state persist for
the whole extension session. If memory matters, add an idle timeout that closes the offscreen
document (losing the warm ffmpeg instance) after e.g. 10 minutes without activity.

**Tests:** the repo has zero automated tests. The highest-value targets are the pure functions
and the trim math that already caused real bugs (absolute `-ss` → empty file):
- `parseTime` / `fmtTime` round-trip;
- `trimStart = start - capturedFrom`, `trimDuration = end - start`, `isFragment`,
  `needsExactCut`, `exactCut`, `doTranscode`, `quickEncode`, `alignedStart` decision matrix;
- `b64encode`/`b64decode` round-trip, incl. chunk boundaries;
- the offscreen run-cascade fallback order.

A zero-dependency harness with `node:test` is sufficient — the functions just need to be
exported (currently they live inside IIFEs). Example (run with `node --test tests/`):

```js
// tests/trim.test.js  (node:test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, fmtTime, computeTrim } from '../extension/lib/format.js';

test('time round-trip', () => {
  for (const sec of [0, 59, 60, 3599, 3661]) assert.equal(parseTime(fmtTime(sec)), sec);
});
test('trim is relative to captured file', () => {
  const { trimStart, trimDuration } = computeTrim({ start: 300, end: 360, capturedFrom: 290, duration: 3600 });
  assert.equal(trimStart, 10);       // relative, not 300
  assert.equal(trimDuration, 60);
});
```

Extract the helpers into a shared module (`extension/lib/format.js`) that both the extension
and the tests import; the extension files keep their IIFE wrappers.

---

## Data-flow map (verified against code)

1. **Install:** `content_hook.js` (MAIN world, `document_start`) patches
   `MediaSource.isTypeSupported`/`canPlayType`/`mediaCapabilities.decodingInfo` to hide AV1
   (forces VP9), patches `addSourceBuffer` (tags MIME/kind) and `appendBuffer` (byte
   concatenation). `content_ui.js` (ISOLATED, `document_idle`) renders the ▽ button via a
   `MutationObserver` on `.ytp-right-controls`.
2. **Menu:** click → `callHook('info')` → player title/duration/heights → menu with fragment
   fields, 2160p/1440p/1080p/720p (1440p/2160p only when the player reports them), MP3,
   subtitles, format radio (stored in `chrome.storage.local`).
3. **Capture:** `download` → hook `playthrough()`: mute+pause, pre-seek to a *different*
   position at a low quality (forces a fresh init on both tracks), arm capture, switch to the
   target quality, seek to `capStart`; then seek-hop along the buffered edge (paused, no fast
   playback) until the range is covered. `capturedFrom` = buffered start ≤ `capStart`.
   Assembled track buffers are transferred back via `postMessage`.
4. **Transfer:** `content_ui.js` → `ytdl-ensure` → ping-wait → `ytdl-begin` (params) →
   `ytdl-chunk` (base64, 4 MB, `seq`-guarded) → `ytdl-finalize` (no retry).
5. **Mux:** offscreen writes `v.<ext>`/`a.<ext>`, then runs a cascade (mp3 | h264 | mp4-copy +
   mp4-copy-untrimmed + webm-copy), keeping the first non-empty result. Trim is **relative to
   the captured file** (`-ss trimStart`, `-t trimStart+trimDuration` for copy; exact cuts are
   re-encoded, ≤ 60 s, preset `ultrafast`).
6. **Save:** blob URL → `ytdl-save` → background `chrome.downloads.download`.
7. **Subtitles:** hook opens the transcript panel (legacy or modern "В этом видео"), prefers
   Russian, extracts text from the DOM (no tokens), returns `{ text, lang }`; UI saves a
   UTF-8 BOM `.txt` via a data URL.

---

## Remaining concerns (not safely fixable automatically)

1. **MAIN-world trust boundary (F5):** a page script can always forge bridge messages; the
   mitigations reduce blast radius (range caps, re-entrancy guard, byte cap) but cannot
   eliminate it. Moving the MSE patch out of the MAIN world is not possible with MV3 content
   scripts.
2. **Inherent capture fragility:** the whole design depends on YouTube's DOM/player internals
   (`.ytp-right-controls`, `movie_player`, `getPlayerResponse`, transcript selectors). Any
   YouTube layout change can silently break parts of it; there is no graceful fallback beyond
   the current `try/catch` guards.
3. **Memory ceiling (F9):** very long high-res captures can exhaust RAM in the offscreen
   document; a hard byte cap (F5) is the only realistic automatic guard.
4. **ffmpeg.wasm codec floor:** if YouTube stops serving VP9 (AV1-only content or a future
   codec), the AV1-steering patch keeps the player on VP9 today, but the bundled core cannot
   be upgraded without re-vendoring `@ffmpeg/core` (license/build considerations noted in
   README).

## Assumptions

- Reviewing "code correctness / quality / consistency" is the priority; the review intentionally
  changed **no** source files (per `ReviewPrompt.txt`).
- No git commit was made: the working tree contains only untracked files (`.agents/`,
  `ReviewPrompt.txt`, `knowledge.md`), nothing meaningful to commit. Happy to commit if desired.
- `extension/vendor/ffmpeg/*` are third-party build artifacts and were only checked for
  presence, not audited.
- Severity grading: High = silent wrong result or permanent breakage; Medium = failure under
  realistic conditions; Low = polish/robustness; Info = documentation/strategy.
