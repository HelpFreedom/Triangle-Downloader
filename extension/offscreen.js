// offscreen.js — runs ffmpeg.wasm in an extension DOM context (a service worker
// can't host ffmpeg). Receives the two captured tracks in chunks, transcodes them
// into a universally-playable H.264/AAC MP4, and hands the result to the background
// for saving. The captured tracks are whatever the player streamed (typically AV1
// or VP9 video + Opus audio), so this re-encodes rather than remuxes.

const { FFmpeg } = FFmpegWASM;

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
  return ffLoading;
}

function b64decode(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function extFor(mime) {
  if (/webm/i.test(mime)) return 'webm';
  if (/mp4/i.test(mime)) return 'mp4';
  return 'bin';
}

async function finalize() {
  const inst = await getFF();
  const isMp3 = acc.format === 'mp3';
  const aName = 'a.' + extFor(acc.audioMime);

  const aBytes = concat(acc.audio);
  if (!aBytes.length) throw new Error('пустые данные аудио');
  await inst.writeFile(aName, aBytes);

  let vName = null;
  if (!isMp3) {
    vName = 'v.' + extFor(acc.videoMime);
    const vBytes = concat(acc.video);
    if (!vBytes.length) throw new Error('пустые данные видео');
    await inst.writeFile(vName, vBytes);
  }

  // Fragment trim. IMPORTANT: -ss counts from the captured file's own beginning, and
  // capture starts at a segment boundary at or before the requested start — so the
  // offset here is RELATIVE (trimStart), never the absolute position in the video.
  // Passing an absolute position produced an empty file (0 bytes of output).
  const trimStart = Math.max(0, Number(acc.trimStart) || 0);
  const trimDuration = Math.max(0, Number(acc.trimDuration) || 0);
  // Re-encoding cuts frame-accurately, so it seeks to the exact requested point.
  // A stream copy cannot: video can only start on a keyframe while audio would be cut
  // precisely, which leaves the lead-in silent. So the copy path seeks nothing and just
  // limits the length — both tracks start together at the keyframe before the request.
  const exact = !!acc.transcode;
  const seek = exact && trimStart > 0.05 ? ['-ss', trimStart.toFixed(3)] : [];
  const limit = trimDuration > 0.05
    ? ['-t', (exact ? trimDuration : trimStart + trimDuration).toFixed(3)]
    : [];
  const inV = (s) => (vName ? [...s, '-i', vName] : []);
  const inA = (s) => [...s, '-i', aName];
  // Stream copy can only cut on keyframes, so a trimmed copy starts at the keyframe
  // BEFORE the requested point. MP4 can hide that lead-in with an edit list, but the
  // skipped frames stay inside the file and players that take the duration from the
  // media track then show a frozen tail at the end. So the copy path always normalizes
  // timestamps (lead-in becomes ordinary content) and exact cuts are produced by
  // re-encoding instead — see the "exact cut" decision in content_ui.js.
  const ZERO = ['-avoid_negative_ts', 'make_zero'];

  const runs = [];
  if (isMp3) {
    runs.push({
      name: 'mp3', out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3',
      args: [...inA(seek), ...limit, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'],
    });
  } else if (acc.transcode) {
    // Re-encode to H.264 + AAC. An automatic exact cut of a short clip favours speed
    // (ultrafast is ~2× quicker at 1080p); the user-selected compatibility mode keeps
    // the better-compressing preset.
    const preset = acc.quickEncode ? 'ultrafast' : 'veryfast';
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
      // If trimming upsets the copy path, keep the whole captured range rather than fail
      // (it covers the fragment, just aligned to segment boundaries).
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
        if (out && out.length > 1024) { data = out; chosen = run; break; }
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
  // keep the blob alive briefly so chrome.downloads can read it, then release
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  return res && res.ok
    ? { ok: true, filename: res.filename || filename }
    : { ok: false, error: (res && res.error) || 'save failed' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;

  // Readiness probe: the sender waits for this before streaming anything, because the
  // service worker resolves createDocument() and only this listener proves the document
  // is actually able to receive.
  if (msg.t === 'ytdl-ping') { sendResponse({ ok: true }); return; }

  if (msg.t === 'ytdl-begin') {
    acc.video = []; acc.audio = []; acc.seq = 0;
    acc.videoMime = msg.videoMime || '';
    acc.audioMime = msg.audioMime || '';
    acc.filename = msg.filename || 'video.mp4';
    acc.transcode = !!msg.transcode;
    acc.format = msg.format || 'mp4';
    acc.quickEncode = !!msg.quickEncode;
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
      acc[msg.track].push(b64decode(msg.b64));
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
