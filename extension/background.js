// background.js — service worker. Owns the offscreen document lifecycle and
// performs the final chrome.downloads save. ffmpeg.wasm cannot run here (a
// service worker has no DOM/Worker/document that ffmpeg needs), so all muxing
// happens in the offscreen document; the worker only orchestrates.

// Last-resort file name: keep the extension, drop emoji and anything else Chrome may
// consider illegal, so a download is never lost just because of the video's title.
function plainFilename(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200B}-\u{200F}\u{2066}-\u{2069}]/gu, '')
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return (base || 'video') + ext;
}

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
    const save = (filename) =>
      chrome.downloads.download({ url: msg.url, filename, saveAs: false });
    save(msg.filename)
      .then((id) => sendResponse({ ok: true, id, filename: msg.filename }))
      .catch(() => {
        // Chrome rejects some titles outright and says only "Invalid filename".
        // Save the finished file under a plain name instead of throwing it away.
        const alt = plainFilename(msg.filename || 'video');
        save(alt)
          .then((id) => sendResponse({ ok: true, id, filename: alt }))
          .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      });
    return true; // async
  }
});
