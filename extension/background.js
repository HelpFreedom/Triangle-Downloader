// background.js — service worker. Owns the offscreen document lifecycle and
// performs the final chrome.downloads save. ffmpeg.wasm cannot run here (a
// service worker has no DOM/Worker/document that ffmpeg needs), so all muxing
// happens in the offscreen document; the worker only orchestrates.
// Also queries the SponsorBlock API (the content script cannot: the page's CORS
// applies there, while the extension's host_permissions apply here).

let creating = null;      // de-dupe concurrent createDocument calls
let progressTab = null;   // tab that started the current job, for progress relay

// Is the offscreen document actually responding? hasDocument() keeps returning
// true for a crashed (e.g. out-of-memory) document, so we ping it and recreate
// on silence — otherwise every later chunk message goes nowhere and the transfer
// dies with "передача данных прервалась".
function pingOffscreen() {
  return Promise.race([
    chrome.runtime.sendMessage({ t: 'ytdl-ping' })
      .then((r) => !!(r && r.pong)).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 2000)),
  ]);
}

// createDocument() resolves as soon as the document exists — NOT when offscreen.js
// has run. offscreen.html first loads the (large) vendor ffmpeg.js, so for a while
// there is a live document with no onMessage listener: every message sent in that
// window resolves to undefined and the transfer dies with "передача данных
// прервалась". So we always wait for a real pong before reporting readiness.
async function waitForOffscreen(attempts) {
  for (let i = 0; i < attempts; i++) {
    if (await pingOffscreen()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function ensureOffscreen() {
  if (creating) { await creating; }

  if (await chrome.offscreen.hasDocument()) {
    if (await waitForOffscreen(10)) return;      // alive (or still booting) → done
    try { await chrome.offscreen.closeDocument(); } catch (e) {} // crashed → recreate
  }

  creating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run ffmpeg.wasm to mux captured video and audio tracks into an MP4.',
  });
  try { await creating; } catch (e) { /* may already exist — the ping below decides */ }
  finally { creating = null; }

  if (!(await waitForOffscreen(40))) {
    // Silence almost always means offscreen.js never ran, and the usual reason is
    // a missing vendor build: offscreen.html loads vendor/ffmpeg/ffmpeg.js first,
    // and if that 404s then FFmpegWASM is undefined, offscreen.js throws on its
    // very first line and no message listener is ever registered.
    const missing = await missingFiles();
    throw new Error(missing.length
      ? 'в папке расширения нет файлов: ' + missing.join(', ') +
        ' — скопируйте их из репозитория и перезагрузите расширение'
      : 'offscreen-документ не отвечает');
  }
}

async function missingFiles() {
  const need = ['offscreen.html', 'offscreen.js',
    'vendor/ffmpeg/ffmpeg.js', 'vendor/ffmpeg/ffmpeg-core.js', 'vendor/ffmpeg/ffmpeg-core.wasm'];
  const missing = [];
  for (const f of need) {
    try {
      const r = await fetch(chrome.runtime.getURL(f), { method: 'GET' });
      if (!r.ok) missing.push(f);
    } catch (e) { missing.push(f); }
  }
  return missing;
}

// ---- SponsorBlock ---------------------------------------------------------
// Which segment categories get cut out of the download:
//   sponsor     — paid sponsor ads
//   selfpromo   — self-promotion / merch
//   interaction — "like & subscribe" reminders
const SB_API = 'https://sponsor.ajay.app';
const SB_CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Privacy-preserving lookup (k-anonymity): we send only the first 4 hex chars of
// sha256(videoID); the server returns all matching videos and we pick ours locally,
// so the API never learns which exact video was requested.
async function sbFetchSegments(videoId) {
  if (!videoId) return [];
  const prefix = (await sha256Hex(videoId)).slice(0, 4);
  const url = SB_API + '/api/skipSegments/' + prefix +
    '?categories=' + encodeURIComponent(JSON.stringify(SB_CATEGORIES));
  const resp = await fetch(url);
  if (resp.status === 404) return []; // no segments for this prefix
  if (!resp.ok) throw new Error('SponsorBlock HTTP ' + resp.status);
  const list = await resp.json();
  const entry = Array.isArray(list) ? list.find((v) => v.videoID === videoId) : null;
  if (!entry || !Array.isArray(entry.segments)) return [];
  return entry.segments
    .filter((s) => (s.actionType ? s.actionType === 'skip' : true))
    .filter((s) => Array.isArray(s.segment) && s.segment[1] > s.segment[0])
    .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== 'string') return;

  // Messages the background is responsible for. Everything else (begin/chunk/
  // finalize) is handled by the offscreen document and ignored here.
  if (msg.t === 'ytdl-ensure') {
    ensureOffscreen().then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }

  // Proxy for everything the offscreen document owns (begin / chunk / finalize).
  // The content script used to message the offscreen document directly, but a
  // content script and an offscreen document are not guaranteed to share a
  // messaging channel — the send resolved to undefined and the transfer died.
  // The service worker CAN talk to the offscreen document, so it relays.
  // ffmpeg progress travels offscreen → worker → tab: runtime.sendMessage from an
  // extension page does not reach content scripts, only tabs.sendMessage does.
  if (msg.t === 'ytdl-progress') {
    if (progressTab != null) {
      chrome.tabs.sendMessage(progressTab, msg).catch(() => {});
    }
    return;
  }

  if (msg.t === 'ytdl-proxy') {
    (async () => {
      const inner = msg.m || {};
      if (inner.t === 'ytdl-begin') {
        progressTab = (sender && sender.tab && sender.tab.id) != null ? sender.tab.id : null;
        await ensureOffscreen();
      }
      const r = await chrome.runtime.sendMessage(inner);
      if (r === undefined) return { ok: false, error: 'offscreen не ответил на ' + inner.t };
      return r;
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async
  }

  if (msg.t === 'ytdl-sb-get') {
    sbFetchSegments(String(msg.videoId || ''))
      .then((segments) => sendResponse({ ok: true, segments }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }

  if (msg.t === 'ytdl-save') {
    // Offscreen finished muxing and handed us a blob URL to save.
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
});
