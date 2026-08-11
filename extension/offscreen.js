// offscreen.js — runs ffmpeg.wasm in an extension DOM context (a service worker
// can't host ffmpeg). Receives the two captured tracks in chunks, transcodes them
// into a universally-playable H.264/AAC MP4, and hands the result to the background
// for saving. The captured tracks are whatever the player streamed (typically AV1
// or VP9 video + Opus audio), so this re-encodes rather than remuxes.

const { FFmpeg } = FFmpegWASM;
// Shared pure helpers (base64 / byte concat / MIME→ext / ffmpeg run cascade) from
// lib/format.js, loaded by offscreen.html BEFORE this script.
const L = window.YTDL_LIB;

let ff = null;
let ffLoading = null;
const acc = { video: [], audio: [], videoMime: '', audioMime: '', filename: 'video.mp4', seq: 0 };
const ffLog = []; // ring buffer of recent ffmpeg log lines for error reporting

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
  // On failure, forget the rejected promise so the NEXT download retries instead of
  // being stuck with a permanently-rejected ffLoading (which would brick all muxing
  // until the extension is reloaded). The current caller still receives the error.
  ffLoading = ffLoading.catch((err) => { ffLoading = null; throw err; });
  return ffLoading;
}

async function finalize() {
  const inst = await getFF();
  const isMp3 = acc.format === 'mp3';
  const aName = 'a.' + L.extFor(acc.audioMime);

  const aBytes = L.concat(acc.audio);
  if (!aBytes.length) throw new Error('пустые данные аудио');
  await inst.writeFile(aName, aBytes);

  let vName = null;
  if (!isMp3) {
    vName = 'v.' + L.extFor(acc.videoMime);
    const vBytes = L.concat(acc.video);
    if (!vBytes.length) throw new Error('пустые данные видео');
    await inst.writeFile(vName, vBytes);
  }

  // Fragment trim. IMPORTANT: -ss counts from the captured file's own beginning, and
  // capture starts at a segment boundary at or before the requested start — so the
  // offset here is RELATIVE (trimStart), never the absolute position in the video.
  // Passing an absolute position produced an empty file (0 bytes of output).
  const trimStart = Math.max(0, Number(acc.trimStart) || 0);
  const trimDuration = Math.max(0, Number(acc.trimDuration) || 0);
  // The run cascade (mp3 / h264 / mp4-copy ± untrimmed / webm-copy) and the seek/limit
  // math live in lib/format.js (buildRuns) — it is unit-tested and identical in prod.
  const runs = L.buildRuns({
    isMp3, transcode: acc.transcode, quickEncode: acc.quickEncode,
    trimStart, trimDuration, vName, aName, mp3Bitrate: acc.mp3Bitrate,
  });

  let data = null, chosen = null;
  const failures = [];
  for (const run of runs) {
    ffLog.length = 0;
    let ret = -1;
    try { ret = await inst.exec(run.args); } catch (e) { ret = -1; ffLog.push(String((e && e.message) || e)); }
    if (ret === 0) {
      try {
        const out = await inst.readFile(run.out);
        // a non-empty result only — a "successful" run can still yield an empty file
        if (out && out.length > 0) { data = out; chosen = run; break; }
        failures.push(run.name + ': пустой результат');
      } catch (e) { failures.push(run.name + ': файл не создан'); }
    } else {
      failures.push(run.name + ' (код ' + ret + '): ' + ffLog.slice(-3).join(' | '));
    }
    try { await inst.deleteFile(run.out); } catch (e) {}
  }
  const lastErr = failures.join('  ||  ');

  // free FS
  try { if (vName) await inst.deleteFile(vName); await inst.deleteFile(aName); } catch (e) {}
  if (chosen) { try { await inst.deleteFile(chosen.out); } catch (e) {} }
  acc.video = []; acc.audio = [];

  if (!chosen) throw new Error(lastErr || 'ffmpeg не собрал файл');

  const filename = acc.filename.replace(/\.(mp4|webm|mp3)$/i, '') + chosen.ext;
  const blob = new Blob([data.buffer], { type: chosen.type });
  const url = URL.createObjectURL(blob);
  const res = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename });
  // The blob is revoked by the background once the download actually completes
  // (ytdl-revoke). Belt-and-braces: if the service worker is terminated before the
  // download finishes, its listener and fallback timer are lost — this document timer
  // always runs and guarantees the blob is eventually released. Double revocation is
  // harmless (revoking an already-revoked URL is a no-op).
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 10 * 60 * 1000);
  return res && res.ok ? { ok: true, filename } : { ok: false, error: (res && res.error) || 'save failed' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;

  // Readiness probe: the sender waits for this before streaming anything, because the
  // service worker resolves createDocument() and only this listener proves the document
  // is actually able to receive.
  if (msg.t === 'ytdl-ping') { sendResponse({ ok: true }); return; }

  if (msg.t === 'ytdl-revoke') {
    // background tells us the download finished (or failed) and the blob is no longer
    // being read — safe to release the object URL now.
    try { URL.revokeObjectURL(msg.url); } catch (e) {}
    sendResponse({ ok: true });
    return; // sync
  }

  if (msg.t === 'ytdl-begin') {
    acc.video = []; acc.audio = []; acc.seq = 0;
    acc.videoMime = msg.videoMime || '';
    acc.audioMime = msg.audioMime || '';
    acc.filename = msg.filename || 'video.mp4';
    acc.transcode = !!msg.transcode;
    acc.format = msg.format || 'mp4';
    acc.quickEncode = !!msg.quickEncode;
    acc.mp3Bitrate = Number(msg.mp3Bitrate) || 192; // kbps, default matches the original
    acc.trimStart = msg.trimStart || 0;
    acc.trimDuration = msg.trimDuration || 0;
    // warm up ffmpeg while chunks stream in
    getFF().catch(() => {});
    sendResponse({ ok: true });
    return; // sync
  }
  if (msg.t === 'ytdl-chunk') {
    try {
      // Chunks are numbered so a retried one can be recognised. Re-applying a chunk
      // whose answer was lost in transit would silently double the data and corrupt
      // the file, and a gap means the document was recreated mid-transfer — better to
      // fail loudly than to write a broken video.
      const seq = Number(msg.seq);
      if (Number.isFinite(seq)) {
        if (seq < acc.seq) { sendResponse({ ok: true, duplicate: true }); return; }
        if (seq > acc.seq) { sendResponse({ ok: false, error: 'пропущен фрагмент данных' }); return; }
      }
      acc[msg.track].push(L.b64decode(msg.b64));
      acc.seq++;
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return; // sync
  }
  if (msg.t === 'ytdl-finalize') {
    finalize()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async
  }
  // other message types belong to the background; ignore.
});
