// offscreen.js — runs ffmpeg.wasm in an extension DOM context (a service worker
// can't host ffmpeg). Receives the two captured tracks in chunks, transcodes them
// into a universally-playable H.264/AAC MP4, and hands the result to the background
// for saving. The captured tracks are whatever the player streamed (typically AV1
// or VP9 video + Opus audio), so this re-encodes rather than remuxes.

const { FFmpeg } = FFmpegWASM;

let ff = null;
let ffLoading = null;
const acc = { video: [], audio: [], videoMime: '', audioMime: '', filename: 'video.mp4' };
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

  // fragment trim: -ss before each input (keyframe seek), -t as output duration
  const start = Math.max(0, Number(acc.start) || 0);
  const end = Number(acc.end) || 0;
  const dur = end > start ? end - start : 0;
  const seek = start > 0 ? ['-ss', String(start)] : [];
  const limit = dur > 0 ? ['-t', String(dur)] : [];
  const inV = vName ? [...seek, '-i', vName] : [];
  const inA = [...seek, '-i', aName];

  const runs = [];
  if (isMp3) {
    runs.push({
      out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3',
      args: [...inA, ...limit, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'],
    });
  } else if (acc.transcode) {
    // Slow path: re-encode to H.264 + AAC so the file plays everywhere.
    runs.push({
      out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
      args: [...inV, ...inA, '-map', '0:v:0', '-map', '1:a:0', ...limit,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4'],
    });
  } else {
    // Fast path: stream-copy the original tracks (VP9/Opus) into mp4 (seconds).
    runs.push({
      out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
      args: [...inV, ...inA, '-map', '0:v:0', '-map', '1:a:0', ...limit,
        '-c', 'copy', '-strict', '-2', '-movflags', '+faststart', 'out.mp4'],
    });
    // If mp4 refuses these codecs, fall back to native WebM copy.
    runs.push({
      out: 'out.webm', type: 'video/webm', ext: '.webm',
      args: [...inV, ...inA, '-map', '0:v:0', '-map', '1:a:0', ...limit, '-c', 'copy', 'out.webm'],
    });
  }

  let data = null, chosen = null, lastErr = '';
  for (const run of runs) {
    ffLog.length = 0;
    const ret = await inst.exec(run.args);
    if (ret === 0) {
      try {
        data = await inst.readFile(run.out);
        if (data && data.length) { chosen = run; break; }
      } catch (e) { /* try next */ }
    }
    lastErr = 'ffmpeg код ' + ret + ': ' + ffLog.slice(-6).join(' | ');
    try { await inst.deleteFile(run.out); } catch (e) {}
  }

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
  return res && res.ok ? { ok: true, filename } : { ok: false, error: (res && res.error) || 'save failed' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'ytdl-begin') {
    acc.video = []; acc.audio = [];
    acc.videoMime = msg.videoMime || '';
    acc.audioMime = msg.audioMime || '';
    acc.filename = msg.filename || 'video.mp4';
    acc.transcode = !!msg.transcode;
    acc.format = msg.format || 'mp4';
    acc.start = msg.start || 0;
    acc.end = msg.end || 0;
    // warm up ffmpeg while chunks stream in
    getFF().catch(() => {});
    sendResponse({ ok: true });
    return; // sync
  }
  if (msg.t === 'ytdl-chunk') {
    try {
      acc[msg.track].push(b64decode(msg.b64));
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
