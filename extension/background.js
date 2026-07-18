// background.js — service worker. Owns the offscreen document lifecycle and
// performs the final chrome.downloads save. ffmpeg.wasm cannot run here (a
// service worker has no DOM/Worker/document that ffmpeg needs), so all muxing
// happens in the offscreen document; the worker only orchestrates.

let creating = null; // de-dupe concurrent createDocument calls

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run ffmpeg.wasm to mux captured video and audio tracks into an MP4.',
  });
  try { await creating; } finally { creating = null; }
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

  if (msg.t === 'ytdl-save') {
    // Offscreen finished muxing and handed us a blob URL to save.
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then((id) => sendResponse({ ok: true, id }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
});
