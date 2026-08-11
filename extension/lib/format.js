// extension/lib/format.js — shared PURE helpers (no extension APIs, no DOM).
//
// Loaded as a classic script BEFORE content_ui.js (ISOLATED-world content script) and
// BEFORE offscreen.js (offscreen.html), where it registers globalThis.YTDL_LIB; the same
// file is require()d by the node:test suite in tests/ (see Audit F9). Keeping the pure
// logic here means the tests exercise the exact code the extension runs.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YTDL_LIB = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- time ----------------------------------------------------------------
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h + ':' + pad(m) + ':' + pad(s);
  }
  function parseTime(str) {
    const parts = String(str).trim().split(':').map((p) => Number(p));
    if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
    let s = 0; for (const p of parts) s = s * 60 + p;
    return s;
  }

  // ---- trim / re-encode decision matrix ------------------------------------
  // Capture starts at a segment boundary at or before `start`, so trimming is RELATIVE
  // to the captured file (ffmpeg's -ss counts from the file's own start). A copied
  // stream can only start on a keyframe, so an exact start needs re-encoding — done
  // automatically only for short clips (exactCutMaxSec); longer fragments stay instant
  // and start at the keyframe before the requested point.
  function computeJob({ start, end, duration, capturedFrom, isMp3, transcode, exactCutMaxSec }) {
    const trimStart = Math.max(0, start - capturedFrom);
    const trimDuration = Math.max(0, end - start);
    const isFragment = start > 0 || end < duration - 0.5;
    const needsExactCut = isFragment && trimStart > 0.3;
    const shortEnough = trimDuration > 0 && trimDuration <= (exactCutMaxSec || 60);
    const exactCut = !isMp3 && needsExactCut && shortEnough;
    const doTranscode = isMp3 ? true : (!!transcode || exactCut);
    const alignedStart = !isMp3 && needsExactCut && !doTranscode;
    const quickEncode = exactCut && !transcode;
    return { trimStart, trimDuration, isFragment, needsExactCut, shortEnough, exactCut, doTranscode, alignedStart, quickEncode };
  }

  // ---- base64 --------------------------------------------------------------
  function b64encode(u8) {
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < u8.length; i += STEP) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + STEP, u8.length)));
    }
    return btoa(s);
  }
  function b64decode(s) {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // ---- filenames -----------------------------------------------------------
  function safeName(s) {
    return (s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  function fragSuffix(start, end, duration) {
    if (start <= 0 && end >= duration - 0.5) return '';
    return ' (' + fmtTime(start).replace(/:/g, '.') + '-' + fmtTime(end).replace(/:/g, '.') + ')';
  }

  // ---- ranges --------------------------------------------------------------
  function splitRange(start, end, partSec) {
    const parts = [];
    for (let s = start; s < end; s += partSec) parts.push({ start: s, end: Math.min(s + partSec, end) });
    return parts;
  }

  // ---- byte buffers --------------------------------------------------------
  function extFor(mime) {
    if (/webm/i.test(mime)) return 'webm';
    if (/mp4/i.test(mime)) return 'mp4';
    return 'bin';
  }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ---- offscreen ffmpeg run cascade ----------------------------------------
  // The order matters: the first run that exits 0 AND produces non-empty output wins.
  // Re-encoding cuts frame-accurately and therefore seeks (-ss); a stream copy cannot
  // start mid-GOP, so it never seeks and just limits the length (both tracks start
  // together at the keyframe before the request). MP4 gets an edit-list-free copy with
  // normalized timestamps so players don't show a frozen tail.
  function buildRuns({ isMp3, transcode, quickEncode, trimStart, trimDuration, vName, aName }) {
    const exact = !!transcode;
    const seek = exact && trimStart > 0.05 ? ['-ss', trimStart.toFixed(3)] : [];
    const limit = trimDuration > 0.05
      ? ['-t', (exact ? trimDuration : trimStart + trimDuration).toFixed(3)]
      : [];
    const inV = (s) => (vName ? [...s, '-i', vName] : []);
    const inA = (s) => [...s, '-i', aName];
    const ZERO = ['-avoid_negative_ts', 'make_zero'];

    const runs = [];
    if (isMp3) {
      runs.push({
        name: 'mp3', out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3',
        // 320 kbps CBR — the highest quality libmp3lame offers; a 320k MP3 stays
        // compatible everywhere (mp3 is an MPEG-1 Layer 3 container, not VBR-fragile).
        args: [...inA(seek), ...limit, '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', 'out.mp3'],
      });
    } else if (transcode) {
      // Re-encode to H.264 + AAC. An automatic exact cut of a short clip favours speed
      // (ultrafast is ~2× quicker at 1080p); the user-selected compatibility mode keeps
      // the better-compressing preset.
      const preset = quickEncode ? 'ultrafast' : 'veryfast';
      runs.push({
        name: 'h264', out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
        args: [...inV(seek), ...inA(seek), '-map', '0:v:0', '-map', '1:a:0', ...limit,
          '-c:v', 'libx264', '-preset', preset, '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4'],
      });
    } else {
      // Fast path: stream-copy the original tracks (VP9/Opus) into mp4 (seconds).
      runs.push({
        name: 'mp4-copy', out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
        args: [...inV(seek), ...inA(seek), '-map', '0:v:0', '-map', '1:a:0', ...limit,
          '-c', 'copy', '-strict', '-2', ...ZERO, '-movflags', '+faststart', 'out.mp4'],
      });
      if (seek.length || limit.length) {
        // If trimming upsets the copy path, keep the whole captured range rather than
        // fail (it covers the fragment, just aligned to segment boundaries).
        runs.push({
          name: 'mp4-copy-untrimmed', out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
          args: [...inV([]), ...inA([]), '-map', '0:v:0', '-map', '1:a:0',
            '-c', 'copy', '-strict', '-2', '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart', 'out.mp4'],
        });
      }
      // Last resort if mp4 refuses these codecs.
      runs.push({
        name: 'webm-copy', out: 'out.webm', type: 'video/webm', ext: '.webm',
        args: [...inV(seek), ...inA(seek), '-map', '0:v:0', '-map', '1:a:0', ...limit,
          '-c', 'copy', ...ZERO, 'out.webm'],
      });
    }
    return runs;
  }

  return {
    fmtTime, parseTime, computeJob,
    b64encode, b64decode,
    safeName, fragSuffix, splitRange,
    extFor, concat, buildRuns,
  };
});
