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

  if (msg.t === 'ytdl-mem') {
    // Adaptive capture-size warning needs real available RAM. chrome.system.* is not
    // available in content scripts, so the UI asks here. Bytes → MB.
    try {
      chrome.system.memory.getInfo((info) => {
        sendResponse({
          ok: true,
          capacity: Math.round(info.capacity / 1048576),
          free: Math.round(info.availableCapacity / 1048576),
        });
      });
      return true; // async
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  }

  if (msg.t === 'ytdl-save') {
    // Offscreen finished muxing and handed us a blob URL to save. downloads.download
    // resolves when the download STARTS; the blob must stay alive until the browser
    // process finishes reading it, so we revoke it on completion (or on failure, or a
    // generous fallback) instead of on a fixed timer.
    const isBlob = /^blob:/.test(msg.url);
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then((id) => {
        if (isBlob) {
          let done = false;
          function revoke() {
            if (done) return;
            done = true;
            chrome.downloads.onChanged.removeListener(onChanged);
            chrome.runtime.sendMessage({ t: 'ytdl-revoke', url: msg.url }).catch(() => {});
          }
          function onChanged(delta) {
            if (delta.id !== id) return;
            if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
              revoke();
            }
          }
          chrome.downloads.onChanged.addListener(onChanged);
          setTimeout(revoke, 10 * 60 * 1000); // belt-and-braces if onChanged never fires
        }
        sendResponse({ ok: true, id });
      })
      .catch((e) => {
        if (isBlob) chrome.runtime.sendMessage({ t: 'ytdl-revoke', url: msg.url }).catch(() => {});
        sendResponse({ ok: false, error: String(e) });
      });
    return true; // async
  }
});
