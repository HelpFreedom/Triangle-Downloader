// offscreen.js — runs ffmpeg.wasm in an extension DOM context (a service worker
// can't host ffmpeg). Receives the two captured tracks in chunks, transcodes them
// into a universally-playable H.264/AAC MP4, and hands the result to the background
// for saving. The captured tracks are whatever the player streamed (typically AV1
// or VP9 video + Opus audio), so this re-encodes rather than remuxes.
//
// SponsorBlock: `acc.sb` holds [{start,end,category}] intervals (absolute video
// time) to remove from the output.
//   * mp3 / H.264 modes already re-encode → we drop the intervals with
//     aselect/select filters (frame-accurate).
//   * fast copy mode can't filter → we stream-copy each kept span into its own
//     part file and join them with the concat demuxer (cut points land on the
//     nearest keyframe, so they can be off by a couple of seconds).

const { FFmpeg } = FFmpegWASM;

let ff = null;
let ffLoading = null;
const acc = { video: [], audio: [], videoMime: '', audioMime: '', filename: 'video.mp4', sb: [] };
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

// ---- SponsorBlock interval math -------------------------------------------
// Clip the raw segments to [start, end], drop tiny ones, sort, merge overlaps.
// Returns merged removal intervals in ABSOLUTE video time.
function mergeCuts(segs, start, end) {
  const clipped = (segs || [])
    .map((s) => [Math.max(start, Number(s.start) || 0), Math.min(end, Number(s.end) || 0)])
    .filter(([a, b]) => b - a > 0.2)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const s of clipped) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 0.1) last[1] = Math.max(last[1], s[1]);
    else merged.push(s);
  }
  return merged;
}

// Invert removal intervals into the spans to KEEP within [start, end].
// `end` may be Infinity (no explicit fragment end) → last span gets end=null.
function keepList(cuts, start, end) {
  const keep = [];
  let cur = start;
  for (const [a, b] of cuts) {
    if (a - cur > 0.5) keep.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (!isFinite(end)) keep.push([cur, null]);
  else if (end - cur > 0.5) keep.push([cur, end]);
  return keep;
}

// select/aselect expression that drops the removal intervals; times must already
// be RELATIVE to the input (-ss shifts timestamps to 0).
function dropExpr(relCuts) {
  return relCuts.map(([a, b]) => 'between(t,' + a.toFixed(3) + ',' + b.toFixed(3) + ')').join('+');
}

// Fast mode with SponsorBlock: stream-copy each kept span, then concat.
// Tries mp4 first, falls back to webm (same as the normal fast path).
async function copyCutConcat(inst, vName, aName, keep) {
  const variants = [
    { ext: 'mp4', type: 'video/mp4', extra: ['-strict', '-2'], concatExtra: ['-movflags', '+faststart'] },
    { ext: 'webm', type: 'video/webm', extra: [], concatExtra: [] },
  ];
  let lastErr = '';
  for (const v of variants) {
    const made = [];
    const clean = async () => {
      for (const f of made) { try { await inst.deleteFile(f); } catch (e) {} }
      try { await inst.deleteFile('list.txt'); } catch (e) {}
    };
    let ok = true;
    for (let i = 0; i < keep.length; i++) {
      const [a, b] = keep[i];
      const part = 'part' + i + '.' + v.ext;
      const t = b != null ? ['-t', String(Math.max(0.1, b - a))] : [];
      ffLog.length = 0;
      const ret = await inst.exec([
        '-ss', String(a), '-i', vName, '-ss', String(a), '-i', aName,
        '-map', '0:v:0', '-map', '1:a:0', ...t, '-c', 'copy', ...v.extra, part,
      ]);
      if (ret !== 0) {
        lastErr = 'ffmpeg код ' + ret + ' (нарезка ' + v.ext + '): ' + ffLog.slice(-6).join(' | ');
        ok = false; break;
      }
      made.push(part);
    }
    if (ok) {
      const list = made.map((p) => "file '" + p + "'").join('\n');
      await inst.writeFile('list.txt', new TextEncoder().encode(list));
      ffLog.length = 0;
      const out = 'out.' + v.ext;
      const ret = await inst.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', ...v.concatExtra, out]);
      if (ret === 0) {
        try {
          const data = await inst.readFile(out);
          if (data && data.length) {
            await clean();
            try { await inst.deleteFile(out); } catch (e) {}
            return { data, chosen: { out, type: v.type, ext: '.' + v.ext }, lastErr: '' };
          }
        } catch (e) {}
      }
      lastErr = 'ffmpeg код ' + ret + ' (склейка ' + v.ext + '): ' + ffLog.slice(-6).join(' | ');
      try { await inst.deleteFile(out); } catch (e) {}
    }
    await clean();
  }
  return { data: null, chosen: null, lastErr };
}

async function finalize() {
  const inst = await getFF();
  const isMp3 = acc.format === 'mp3';
  const aName = 'a.' + extFor(acc.audioMime);

  // concat + release the chunk arrays immediately — on long videos the tracks are
  // hundreds of MB, and holding chunks + concat + ffmpeg FS at once risks OOM
  const aBytes = concat(acc.audio);
  acc.audio = [];
  if (!aBytes.length) throw new Error('пустые данные аудио');
  await inst.writeFile(aName, aBytes);

  let vName = null;
  if (!isMp3) {
    vName = 'v.' + extFor(acc.videoMime);
    const vBytes = concat(acc.video);
    acc.video = [];
    if (!vBytes.length) throw new Error('пустые данные видео');
    await inst.writeFile(vName, vBytes);
  }

  // fragment trim: -ss before each input (keyframe seek), -t as output duration
  const start = Math.max(0, Number(acc.start) || 0);
  const end = Number(acc.end) || 0;
  const effEnd = end > start ? end : Infinity;
  const dur = isFinite(effEnd) ? effEnd - start : 0;
  const seek = start > 0 ? ['-ss', String(start)] : [];
  const limit = dur > 0 ? ['-t', String(dur)] : [];
  const inV = vName ? [...seek, '-i', vName] : [];
  const inA = [...seek, '-i', aName];

  // SponsorBlock removal intervals (absolute), and relative to the -ss shift
  let cuts = mergeCuts(acc.sb, start, effEnd);
  let keep = keepList(cuts, start, effEnd);
  if (!keep.length) { cuts = []; keep = keepList([], start, effEnd); } // everything flagged → keep as is
  const relCuts = cuts.map(([a, b]) => [Math.max(0, a - start), b - start]);
  const expr = relCuts.length ? dropExpr(relCuts) : '';

  let data = null, chosen = null, lastErr = '';

  // Fast copy mode with cuts: per-span copy + concat (no re-encode).
  if (!isMp3 && !acc.transcode && cuts.length) {
    ({ data, chosen, lastErr } = await copyCutConcat(inst, vName, aName, keep));
    if (!data) console.warn('[Triangle] вырезание в режиме copy не удалось, скачиваю без вырезания:', lastErr);
  }

  if (!data) {
    const runs = [];
    if (isMp3) {
      const af = expr
        ? ['-af', "aselect='not(" + expr + ")',asetpts=N/SR/TB"]
        : [];
      runs.push({
        out: 'out.mp3', type: 'audio/mpeg', ext: '.mp3',
        args: [...inA, ...limit, '-vn', ...af, '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'],
      });
    } else if (acc.transcode) {
      // Slow path: re-encode to H.264 + AAC so the file plays everywhere.
      const maps = expr
        ? ['-filter_complex',
           "[0:v]select='not(" + expr + ")',setpts=N/FRAME_RATE/TB[v];" +
           "[1:a]aselect='not(" + expr + ")',asetpts=N/SR/TB[a]",
           '-map', '[v]', '-map', '[a]']
        : ['-map', '0:v:0', '-map', '1:a:0'];
      runs.push({
        out: 'out.mp4', type: 'video/mp4', ext: '.mp4',
        args: [...inV, ...inA, ...maps, ...limit,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4'],
      });
    } else {
      // Fast path: stream-copy the original tracks (VP9/Opus) into mp4 (seconds).
      // (Also the fallback when SponsorBlock cutting failed above.)
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
    if (chosen) { try { await inst.deleteFile(chosen.out); } catch (e) {} }
  }

  // free FS
  try { if (vName) await inst.deleteFile(vName); await inst.deleteFile(aName); } catch (e) {}
  acc.video = []; acc.audio = []; acc.sb = [];

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

  if (msg.t === 'ytdl-ping') {
    sendResponse({ pong: true });
    return; // sync
  }
  if (msg.t === 'ytdl-begin') {
    acc.video = []; acc.audio = [];
    acc.videoMime = msg.videoMime || '';
    acc.audioMime = msg.audioMime || '';
    acc.filename = msg.filename || 'video.mp4';
    acc.transcode = !!msg.transcode;
    acc.format = msg.format || 'mp4';
    acc.start = msg.start || 0;
    acc.end = msg.end || 0;
    acc.sb = Array.isArray(msg.sb) ? msg.sb : [];
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
