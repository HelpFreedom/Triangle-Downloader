// content_hook.js — runs in the PAGE (MAIN world) at document_start, before the
// YouTube player initializes. It patches MediaSource so we can capture the exact
// bytes the player feeds into its video/audio SourceBuffers.
//
// Verified behaviour of the modern (SABR) web player:
//   * There are two SourceBuffers — one video, one audio — created via
//     addSourceBuffer(mime), so we classify each by its MIME.
//   * The player feeds appendBuffer() ARBITRARY byte fragments (16–128 KB), not
//     whole segments, and the container is often WebM (VP9/AV1 + Opus), sometimes
//     fragmented MP4. So we do NOT parse boxes. Instead we simply concatenate every
//     byte appended to a track, in order, which reconstructs that track's original
//     file exactly. This is only valid if fragments arrive in stream order, so we
//     capture during a monotonic forward play-through (never seeking backward).
//
// Communication with the isolated-world UI script is via window.postMessage.
(function () {
  if (window.__ytdlHookInstalled) return;
  window.__ytdlHookInstalled = true;

  const store = {
    videoId: null,
    capturing: false,
    tracks: Object.create(null),   // kind -> { mime, parts: Uint8Array[] }
    // Latest init segment seen per track, kept UNGATED. Init segments usually arrive
    // once at load (audio itag is the same Opus at every quality, so a quality switch
    // does NOT re-init audio) — so we remember them and seed a track that starts
    // receiving media mid-capture without a fresh init of its own.
    lastInit: Object.create(null), // kind -> { bytes: Uint8Array, mime: string }
    sb: Object.create(null),       // kind -> latest SourceBuffer (for per-track buffered edges)
    restarts: Object.create(null), // kind -> mid-capture re-init count (track was CUT)
  };

  function vidId() { try { return new URLSearchParams(location.search).get('v'); } catch (e) { return null; } }
  function resetTracks() { store.tracks = Object.create(null); }

  // Verbose diagnostics are OFF by default. Flip DEBUG to true when debugging
  // quality/capture issues — the logs show the actual served resolution, mid-capture
  // re-inits, and the menu selection result on a live player (they were the only way
  // to diagnose the external "YouTube Auto HD + FPS" conflict, see knowledge.md).
  const DEBUG = false;
  const dbg = (...a) => { if (DEBUG) console.log('[YTDL]', ...a); };

  // ---- steer the player away from AV1 -------------------------------------
  // The bundled ffmpeg core can decode VP9/Opus but NOT AV1. YouTube only picks
  // AV1 when the page reports it as decodable, so — before the player probes —
  // we make AV1 look unsupported. The player then serves VP9, which we can
  // transcode to H.264. Must run at document_start, before the player loads.
  const isAv1 = (s) => typeof s === 'string' && /av01|av1\b/i.test(s);
  try {
    const origITS = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) => (isAv1(type) ? false : origITS(type));
  } catch (e) {}
  try {
    const proto = HTMLMediaElement.prototype;
    const origCPT = proto.canPlayType;
    proto.canPlayType = function (type) { return isAv1(type) ? '' : origCPT.call(this, type); };
  } catch (e) {}
  try {
    if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
      const origDI = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
      navigator.mediaCapabilities.decodingInfo = (cfg) => {
        if (cfg && cfg.video && isAv1(cfg.video.contentType)) {
          return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
        }
        return origDI(cfg);
      };
    }
  } catch (e) {}

  function u8of(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }
  // Byte-identical init segments mean the player re-appended the SAME stream (e.g. a
  // buffer-eviction recovery) — the media before and after is contiguous and the same
  // codec, so the track can be glued. A different init means a real quality switch.
  function sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Does this appended chunk begin a fresh track file? A valid concatenation must
  // start at the init segment, so we only begin recording a track from the chunk
  // that starts with one. WebM/Matroska → EBML magic; fragmented MP4 → 'ftyp' box.
  function startsWithInit(u8) {
    if (u8.length >= 4 && u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) return true;
    if (u8.length >= 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return true;
    return false;
  }

  // ---- patches -------------------------------------------------------------
  const OrigAddSB = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = OrigAddSB.call(this, mime);
    try {
      sb.__ytdlMime = mime;
      sb.__ytdlKind = /audio/i.test(mime) ? 'audio' : (/video/i.test(mime) ? 'video' : null);
      // Remember the LATEST SourceBuffer per kind so the capture loop can read the
      // track's OWN buffered edge. The element's v.buffered is the UNION across tracks,
      // which lies when audio buffers ahead of video (high bitrates) — the union edge
      // would then "complete" a capture whose video track is still short.
      if (sb.__ytdlKind) store.sb[sb.__ytdlKind] = sb;
    } catch (e) {}
    return sb;
  };

  const OrigAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const kind = this.__ytdlKind;
      if (kind === 'video' || kind === 'audio') {
        const u8 = u8of(data);
        if (u8 && u8.length) {
          const init = startsWithInit(u8);
          // Always remember the latest init (ungated) — it usually only arrives at load.
          if (init) store.lastInit[kind] = { bytes: u8.slice(), mime: this.__ytdlMime || '' };
          if (store.capturing) {
            if (init) {
              const t = store.tracks[kind];
              if (t && t.parts.length) {
                // A fresh init mid-capture means the player cleared its buffer and
                // restarted (remove() + new init). This is usually a buffer-eviction
                // recovery at the SAME quality (the quality is never re-applied during
                // capture), NOT a quality switch. When the new init is byte-identical
                // to the track's own init, the stream before and after the reset is the
                // same codec and contiguous in time — so we DROP the redundant init and
                // keep appending, and the captured file stays whole (a seam, not a cut).
                // A DIFFERENT init means a real quality switch: the streams can't be
                // glued, so the track starts over (CUT) and it is counted so the result
                // is honestly reported as incomplete.
                if (sameBytes(u8, t.initBytes)) {
                  t.seams = (t.seams || 0) + 1;
                  dbg('capture re-init', kind, 'same-stream — glued (seam)', t.seams, 'bytes', totalCaptured());
                } else {
                  // A DIFFERENT-stream re-init (real quality switch). At the very START
                  // of the capture it is usually the tail of OUR OWN target-quality
                  // switch still settling — the replacement track re-covers the whole
                  // range, so it must NOT be counted as a cut (it produced a false
                  // "файл может быть обрезан" message on complete files). Only a
                  // re-init well into the capture actually shortens the file.
                  const nearStart = Math.abs((store.cursor || 0) - (store.capStart || 0)) < 2;
                  if (!nearStart) store.restarts[kind] = (store.restarts[kind] || 0) + 1;
                  store.tracks[kind] = { mime: this.__ytdlMime || '', parts: [u8.slice()], initBytes: u8.slice() };
                  dbg('capture re-init', kind, nearStart ? 'start-of-capture — replaced, not counted' : ('DIFFERENT stream — track cut (restart) ' + (store.restarts[kind] || 1)));
                }
              } else {
                store.tracks[kind] = { mime: this.__ytdlMime || '', parts: [u8.slice()], initBytes: u8.slice() };
              }
            } else {
              const t = store.tracks[kind];
              if (t) {
                t.parts.push(u8.slice());
              } else if (store.lastInit[kind]) {
                // media arrived without a fresh init → seed the track with the stored init
                store.tracks[kind] = {
                  mime: store.lastInit[kind].mime,
                  parts: [store.lastInit[kind].bytes, u8.slice()],
                  initBytes: store.lastInit[kind].bytes,
                };
              }
              // else: no init available yet — skip until one appears
            }
          }
        }
      }
    } catch (e) { /* never break playback */ }
    return OrigAppend.apply(this, arguments);
  };

  function assemble(kind) {
    const t = store.tracks[kind];
    if (!t || !t.parts.length) return null;
    let n = 0; for (const p of t.parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0; for (const p of t.parts) { out.set(p, o); o += p.length; }
    return { bytes: out, mime: t.mime };
  }

  // Total captured bytes across both tracks — a memory safety valve so a forged or
  // pathological capture can't make the page (and its offscreen copy) accumulate
  // unbounded data. Breaking on this leaves `complete` false, which the UI surfaces.
  const BYTE_CAP = 4 * 1024 * 1024 * 1024; // ~4 GB
  function totalCaptured() {
    let n = 0;
    for (const kind of ['video', 'audio']) {
      const t = store.tracks[kind];
      if (t) for (const p of t.parts) n += p.length;
    }
    return n;
  }

  // ---- player helpers ------------------------------------------------------
  function player() { return document.getElementById('movie_player'); }
  function video() { return document.querySelector('video'); }
  // quality name per capture height — YouTube's setPlaybackQuality keys
  const Q = { 2160: 'hd2160', 1440: 'hd1440', 1080: 'hd1080', 720: 'hd720' };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // The LOWEST quality available in the player — the pre-capture flush target. (The JS
  // quality API — both setPlaybackQualityRange and setPlaybackQuality — is IGNORED by
  // the SABR player for switching quality, which is why downloads used to require setting
  // the resolution by hand; the native settings menu is the ONLY reliable switch.)
  function lowestAvailableHeight() {
    const hs = availableHeights();
    return hs.length ? Math.min.apply(null, hs) : 0;
  }
  function availableHeights() {
    try {
      const map = { hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240 };
      return (player().getAvailableQualityLevels() || []).map(l => map[l]).filter(Boolean);
    } catch (e) { return []; }
  }

  // Expected minimum decoded height per requested quality — the lower bound of the
  // settled band used by forceQuality (the upper bound is RES_NAME + 150). The ABR
  // player can silently serve a LOWER resolution than requested, so we verify the
  // actually decoded videoHeight and re-apply until it sticks (see forceQuality).
  const RES_H = { hd2160: 2000, hd1440: 1300, hd1080: 1000, hd720: 700, medium: 300, small: 200, tiny: 100 };
  // Actual resolution height per quality key — what the native menu labels items with
  // ("1440p"/"2160p"). menuSetQuality matches menu text against THIS, not RES_H (a
  // verification threshold).
  const RES_NAME = { hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };
  function servedHeight() { try { return video().videoHeight || 0; } catch (e) { return 0; } }

  // Force the quality the way the user does it: through the native settings menu — the
  // ONLY reliable quality switcher in the SABR player (the JS API, fixed or range, is
  // ignored for switching: users had to set the resolution by hand for downloads to
  // work). `sel` is a numeric height (e.g. 1440) or the string 'auto' (re-selects
  // "Автоматически"). Best-effort: returns true when the target was selected, false when
  // the menu wasn't reachable. NO state toggles here — we only ever open the menu, pick a
  // quality, and close it (the user's layout is left exactly as it was).
  function menuItemLabel(it) {
    try {
      const l = it.querySelector('.ytp-menuitem-label') || it.querySelector('.ytp-menuitem-title') || it;
      return (l.textContent || '').trim();
    } catch (e) { return ''; }
  }
  async function menuSetQuality(sel) {
    const gear = document.querySelector('.ytp-settings-button');
    if (!gear) { dbg('menuSetQuality: no gear button'); return false; }
    const isOpen = () => {
      try {
        const m = document.querySelector('.ytp-settings-menu');
        return !!(m && (m.offsetParent !== null || m.getClientRects().length));
      } catch (e) { return false; }
    };
    // Only VISIBLE items: hidden submenu panels stay in the DOM, and clicking a hidden
    // item is a no-op. getClientRects() returns nothing for display:none/hidden elements.
    const items = () => [...document.querySelectorAll('.ytp-settings-menu .ytp-menuitem')]
      .filter(it => { try { return it.getClientRects().length > 0; } catch (e) { return false; } });
    // The user's player UI must be left exactly as it was, so EVERY exit path — including
    // failures — closes the settings menu instead of leaving it open over the player.
    const closeIfOpen = () => { try { if (isOpen()) gear.click(); } catch (e) {} };
    try {
      if (isOpen()) { gear.click(); await sleep(250); }
      gear.click(); // open the settings menu
      for (let i = 0; i < 20 && !items().length; i++) await sleep(150);
      const qItem = items().find(it => /качеств|quality/i.test(menuItemLabel(it)));
      if (!qItem) { closeIfOpen(); dbg('menuSetQuality: no quality entry'); return false; }
      qItem.click();
      let qItems = [];
      for (let i = 0; i < 25; i++) {
        qItems = items().filter(it => /^\d{3,4}p/i.test(menuItemLabel(it)) || /автоматически|auto/i.test(menuItemLabel(it)));
        if (qItems.length) break;
        await sleep(150);
      }
      if (!qItems.length) { closeIfOpen(); dbg('menuSetQuality: no visible quality items'); return false; }
      if (sel === 'auto') {
        const autoItem = qItems.find(it => /автоматически|auto/i.test(menuItemLabel(it)));
        if (!autoItem) { closeIfOpen(); dbg('menuSetQuality: no auto entry'); return false; }
        autoItem.click();
        await sleep(250);
        closeIfOpen();
        dbg('menuSetQuality: selected auto');
        return true;
      }
      // Prefer the PLAIN entry ("1080p") over "1080p Premium" — the Premium variant is
      // subscription-gated and selecting it when unavailable fails — and over
      // "1080p60". Accept any variant that starts with the target height (labels
      // normalize to digits: "1080p60" → "108060"). Premium is only a last resort
      // (subscribers with no plain entry at that height).
      const norm = (t) => String(t).replace(/[^0-9]/g, '');
      const label = (it) => menuItemLabel(it);
      const plain = qItems.filter(it => !/premium|премиум/i.test(label(it)));
      const exact = plain.filter(it => norm(label(it)) === String(sel))[0];
      const target = exact
                  || plain.filter(it => norm(label(it)).startsWith(String(sel)))[0]
                  || qItems.filter(it => norm(label(it)) === String(sel))[0]
                  || qItems.filter(it => norm(label(it)).startsWith(String(sel)))[0];
      if (!target) { closeIfOpen(); dbg('menuSetQuality: no entry for', sel, qItems.map(menuItemLabel)); return false; }
      target.click();
      await sleep(250);
      closeIfOpen(); // the menu may auto-close on selection; close it if it didn't
      dbg('menuSetQuality: selected', sel);
      return true;
    } catch (e) { closeIfOpen(); dbg('menuSetQuality exception:', e); return false; }
  }
  // Select the requested quality via the NATIVE settings menu — the only reliable quality
  // switcher in the SABR player (the JS API, fixed or range, is ignored for switching:
  // that is why downloads used to require setting the resolution by hand) — and confirm
  // the player actually serves it, ALL before recording starts (any switch during capture
  // re-inits the SourceBuffer and cuts the track; same-stream re-inits are glued as seams).
  // "Settled" means the decoded frame height is inside the band [wantH, wantRes + 150]:
  // waiting on BOTH sides — the height must RISE for an upgrade AND FALL for a downgrade —
  // so the switch has fully completed before recording. Video targets that can't be
  // confirmed within ~12 s abort with a clear error (an honest failure beats a mislabelled
  // file); mp3 is best-effort (only audio is used — the video is just capped to save RAM).
  async function forceQuality(wantRes, wantH, needVideo) {
    const qBefore = (() => { try { return player().getPlaybackQuality(); } catch (e) { return '?'; } })();
    const settled = () => {
      const h = servedHeight();
      return h >= wantH && h <= wantRes + 150;
    };
    if (!await menuSetQuality(wantRes)) {
      await sleep(400);
      if (!await menuSetQuality(wantRes)) {
        dbg('quality: menu unreachable — cannot switch');
        if (needVideo && !settled()) {
          throw new Error('не удалось переключить плеер на ' + wantRes + 'p — меню качества недоступно, установите ' + wantRes + 'p вручную и повторите');
        }
        return;
      }
    }
    const iter = needVideo ? 60 : 25;
    for (let i = 0; i < iter && !settled(); i++) {
      if (i === Math.floor(iter / 2)) await menuSetQuality(wantRes); // re-select mid-way, still pre-recording
      await sleep(200);
    }
    dbg('quality', { before: qBefore, after: (() => { try { return player().getPlaybackQuality(); } catch (e) { return '?'; } })(), served: servedHeight() });
    if (needVideo && !settled()) {
      throw new Error('не удалось переключить плеер на ' + wantRes + 'p (плеер отдаёт ' +
        (servedHeight() || '?') + 'p) — установите ' + wantRes + 'p вручную в плеере и повторите');
    }
  }
  // Restore the user's pre-download quality after the capture (the capture left the
  // player at the requested resolution). Best-effort through the native menu — the only
  // reliable switch; 'auto' re-selects "Автоматически". Never throws.
  async function restoreQuality(prevKey) {
    if (!prevKey || prevKey === '?' || prevKey === 'null') return;
    try {
      if (/^auto/i.test(prevKey)) { await menuSetQuality('auto'); return; }
      const h = RES_NAME[prevKey];
      if (h) await menuSetQuality(h);
    } catch (e) { dbg('restoreQuality:', e); }
  }
  // Seek via the player API, which also updates YouTube's app-level streaming
  // position — plain v.currentTime only moves the element, so the player would
  // keep feeding segments from wherever the user left the scrubber.
  function seekVia(sec) {
    const p = player();
    try { if (p && p.seekTo) { p.seekTo(sec, true); return; } } catch (e) {}
    try { video().currentTime = sec; } catch (e) {}
  }
  // total buffered seconds from 0 (contiguous coverage)
  function contiguousEnd(v) {
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= end + 0.5) end = Math.max(end, v.buffered.end(i));
    }
    return end;
  }

  // Turn off YouTube's "Autoplay next" toggle. Called on load and on every
  // navigation so the next video never starts on its own. Returns true once the
  // toggle button exists (whether it was already off or we just switched it off).
  function keepAutoplayOff() {
    try {
      const btn = document.querySelector('.ytp-autonav-toggle-button');
      if (!btn) return false;
      if (btn.getAttribute('aria-checked') === 'true') btn.click();
      return true;
    } catch (e) { return false; }
  }

  // Capture the whole selected quality by playing forward fast. The browser
  // buffers ahead of the playhead, so we keep the playhead safely BEFORE the end
  // (never triggering the end / autoplay-next) and just wait for the buffer to
  // cover the whole duration. Capture aborts if the page navigates to another video.
  async function playthrough(opts, onProgress) {
    const targetQ = opts.targetQ;   // e.g. 'hd1080' / 'medium' (mp3)
    const needVideo = opts.needVideo !== false; // mp3 only needs audio
    const v = video();
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error('duration unknown');
    const capEnd = Math.min(opts.end && opts.end > 0 ? opts.end : dur, dur);
    const capStart = Math.max(0, Math.min(opts.start || 0, Math.max(0, capEnd - 1)));
    const capId = vidId();
    // Verification band for the served height: [wantH, wantRes + 150]. ALL qualities go
    // through the native menu (the JS API cannot switch quality in the SABR player).
    const wantH = RES_H[targetQ] || 0;       // lower bound of the served-height band
    const wantRes = RES_NAME[targetQ] || 0;  // requested height — the band centre / menu label

    const prev = { paused: v.paused, rate: v.playbackRate, time: v.currentTime, muted: v.muted };
    // Remember the user's current quality so it can be restored when the capture ends
    // (the capture switches the player to the requested resolution).
    const prevKey = (() => { try { return player().getPlaybackQuality(); } catch (e) { return null; } })();
    keepAutoplayOff();
    try { v.muted = true; } catch (e) {}
    try { v.pause(); } catch (e) {}

    // Order matters — every quality change happens through the native settings menu, the
    // only reliable switcher in the SABR player (the JS API, fixed or range, is ignored):
    //  1) FLUSH: switch to the LOWEST available quality. That forces the player to
    //     re-fetch fresh segments at a DIFFERENT itag, evicting any stale buffer that
    //     could cover capStart — without it, a video already playing at the requested
    //     quality would keep its buffer, the later seek to capStart would not be a real
    //     jump, and the capture would never see a fresh init ("не удалось захватить
    //     аудио"). Best-effort: if the menu can't be driven we continue anyway.
    //  2) seek to a position clearly DIFFERENT from capStart (a real jump also re-inits
    //     AUDIO, whose itag is the same Opus at every quality — only a position change
    //     re-fetches it), then select the target quality and VERIFY the player actually
    //     serves it — all while recording is still OFF — and only then start recording
    //     and seek to capStart. Capture begins at the requested fragment, not the video's
    //     start.
    const preSeek = capStart > 10 ? (dur - 5 > 10 ? dur - 5 : 0) : Math.min(35, Math.max(1, dur - 5));
    try {
      // The flush (switch to the lowest quality) is only needed when the player is ALREADY
      // at the requested quality — then the target switch below would be a no-op and the
      // stale buffer would survive. When the current quality differs, the target switch
      // itself re-fetches at a different itag and evicts the old buffer, so the flush
      // dance is skipped (it visibly delayed every download).
      const flushNeeded = !prevKey || prevKey === '?' || prevKey === targetQ;
      const lowH = flushNeeded ? lowestAvailableHeight() : 0;
      if (lowH) {
        try { await menuSetQuality(lowH); } catch (e) {}
        await sleep(500); // let the flush switch start (recording is still OFF)
      }
      seekVia(preSeek);
      await sleep(700);

      // Select the requested quality BEFORE recording anything and verify the player
      // actually serves it — via the native settings menu (the same path the user clicks
      // manually). From here on the quality is NEVER touched again — any switch
      // mid-recording re-inits the SourceBuffer and CUTS the recorded track (same-stream
      // re-inits are glued as seams; different-stream ones are counted as restarts and
      // reported as partial). forceQuality throws a clear error when the requested
      // quality can't be confirmed — a capture that starts at the wrong resolution would
      // produce a mislabelled file, which is worse than an honest failure.
      await forceQuality(wantRes, wantH, needVideo);
    } catch (e) {
      // Restore the player state on a PRE-recording failure (the capture loop below has
      // its own finally): an unconfirmed quality must not leave the player muted or stuck
      // at a different position. The error propagates to the bridge as a clear message.
      try { v.playbackRate = prev.rate; } catch (err) {}
      seekVia(prev.time);
      try { v.muted = prev.muted; } catch (err) {}
      await restoreQuality(prevKey); // the flush already changed the quality
      if (!prev.paused) { try { v.play(); } catch (err) {} }
      throw e;
    }

    resetTracks();
    // NOTE: store.sb is NOT reset here — the SourceBuffers were created when the player
    // loaded and the addSourceBuffer patch already registered the current ones. Wiping
    // them would blind trackEdge() and the per-track capture loop would fall back to the
    // union edge (the very freeze bug we're fixing).
    store.restarts = Object.create(null);
    // Capture context for the appendBuffer patch: a re-init arriving within ~2 s of the
    // start is our own quality switch settling (harmless), later ones are real cuts.
    store.capStart = capStart;
    store.capEnd = capEnd;
    store.cursor = capStart;
    store.capturing = true;
    seekVia(capStart);
    await sleep(500);

    // Wait until both tracks we need start appending (their init arrives). From here on
    // the quality is NEVER touched again — a switch mid-recording would re-init and cut
    // the track short, which is why any such restart is tracked and reported as partial.
    const haveInits = () => store.tracks.audio && (!needVideo || store.tracks.video);
    for (let i = 0; i < 40 && !haveInits(); i++) await sleep(200);

    // Seek-driven capture — NO fast playback. The player buffers a window ahead
    // while paused, then plateaus; we hop the scrubber to the buffered edge to pull
    // the next window, and repeat. This never decodes fast (no freezes) and looks
    // like ordinary buffering to YouTube. Segments arrive strictly in order (verified:
    // monotonic cluster timecodes, no duplicates) because we only ever seek forward
    // to the contiguous edge.
    const bufferedEndAt = (t) => {
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) return v.buffered.end(i);
      }
      return t;
    };
    // Where the captured data actually begins: the player can only start at a segment
    // boundary at or before capStart, so the file may lead in by a few seconds. The
    // caller needs this to trim RELATIVE to the file (ffmpeg's -ss counts from the
    // file's own start, not from the video's absolute timeline).
    const bufferedStartAt = (t) => {
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) return v.buffered.start(i);
      }
      return t;
    };
    // Per-track buffered edge. v.buffered is the UNION across SourceBuffers: at high
    // bitrates the audio buffer can extend far beyond the video one, so the union edge
    // would "complete" the capture while the VIDEO track is still a few seconds long —
    // producing a file that freezes on the last decoded frame (video ends, audio runs on).
    // Driving hops and completion off the real per-track edges keeps them advancing
    // together. Falls back to the union edge only when a SourceBuffer reference is stale.
    const trackEdge = (kind, t) => {
      try {
        const sb = store.sb[kind];
        if (!sb) return 0;
        const b = sb.buffered;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i);
        }
        return 0;
      } catch (e) { return 0; }
    };
    let capturedFrom = capStart;
    let cursor = capStart, stall = 0;
    let complete = false;
    let actualH = 0;
    let seamCount = 0;           // same-stream re-inits glued into the track (not cuts)
    const span = Math.max(0.1, capEnd - capStart);
    const started = Date.now();
    try {
      try { v.pause(); } catch (e) {}
      capturedFrom = Math.min(capStart, bufferedStartAt(capStart));
      while (true) {
        await sleep(350);
        if (vidId() !== capId) throw new Error('видео переключилось во время захвата');
        try { if (!v.paused) v.pause(); } catch (e) {} // keep it paused; buffering runs anyway

        const unionEdge = bufferedEndAt(cursor);
        const vRaw = needVideo ? trackEdge('video', cursor) : capEnd;
        const aRaw = trackEdge('audio', cursor);
        const vE = vRaw || unionEdge;
        const aE = aRaw || unionEdge;
        const edge = Math.min(vE, aE, capEnd);
        onProgress(Math.min(0.99, Math.max(0, edge - capStart) / span));
        // Complete ONLY when the RAW per-track edges reached the end. A fallback union
        // edge must never count — audio's far-ahead buffer would declare a short video
        // track done and we'd ship the frozen-frame file again.
        if (vRaw >= capEnd - 0.6 && aRaw >= capEnd - 0.6) { complete = true; break; }
        if (totalCaptured() > BYTE_CAP) break;          // memory safety valve → incomplete

        if (edge > cursor + 0.3) {                       // window extended → hop to the edge
          cursor = edge;
          store.cursor = cursor; // keep the patch aware of the playhead for restart classification
          seekVia(Math.min(cursor, capEnd - 0.1));
          stall = 0;
        } else {                                         // plateaued → nudge to re-trigger fetch
          stall++;
          if (stall % 4 === 0) seekVia(Math.min(cursor + 0.1, capEnd - 0.1));
          if (stall >= 60) break;                        // ~21s with no progress → give up
        }
        if (Date.now() - started > 20 * 60 * 1000) break; // hard cap
      }
      capturedFrom = Math.min(capturedFrom, bufferedStartAt(capStart));
      actualH = servedHeight(); // resolution the player actually served during capture
      seamCount = ((store.tracks.video && store.tracks.video.seams) || 0) +
                  ((store.tracks.audio && store.tracks.audio.seams) || 0);
      // Buffer-eviction guard: only meaningful when the capture had NO mid-capture
      // re-inits. If the browser evicted the START of the buffered range and the player
      // re-fetched WITHOUT re-initing, the re-fetched bytes duplicate already-captured
      // data and a full-video download (no trimming) would silently ship a corrupt file —
      // so complete only when the video buffer still covers the capture start. A
      // same-stream re-init (seam) is glued and keeps the bytes whole; a different-stream
      // re-init is counted as a restart below and already forces incomplete.
      if (complete && needVideo && seamCount === 0) {
        try {
          const sb = store.sb.video;
          if (sb) {
            const b = sb.buffered;
            let covers = false;
            for (let i = 0; i < b.length; i++) {
              if (b.start(i) <= capStart + 0.5 && b.end(i) >= capStart) { covers = true; break; }
            }
            if (!covers) complete = false;
          }
        } catch (e) {}
      }
    } finally {
      store.capturing = false;
      // restore player state
      try { v.playbackRate = prev.rate; } catch (e) {}
      seekVia(prev.time);
      try { v.muted = prev.muted; } catch (e) {}
      keepAutoplayOff(); // leave autoplay disabled — don't turn it back on
      // restore the user's pre-download quality (the capture left it at the target)
      await restoreQuality(prevKey);
      if (!prev.paused) { try { v.play(); } catch (e) {} }
    }
    // A mid-capture re-init (quality switch / buffer flush) REPLACED a track, so part of
    // the range is missing from the file — report honestly as incomplete. Same-stream
    // re-inits (seams) were glued and do NOT cut the file.
    const restartCount = (store.restarts.video || 0) + (store.restarts.audio || 0);
    if (restartCount > 0) complete = false;
    // NOTE: restarts/bytes are logged as SEPARATE arguments because Chrome's console
    // collapses an object into "{...}" when copied, hiding the values.
    dbg('capture', { targetQ, requestedH: wantRes, servedH: actualH, complete, seams: seamCount }, 'restarts:', restartCount, 'bytes:', totalCaptured());

    onProgress(1);
    return { capturedFrom: Math.max(0, capturedFrom), complete, actualH: actualH || 0, restarts: restartCount, seams: seamCount };
  }

  // ---- subtitles (read from the built-in transcript panel) -----------------
  // No media capture / no timedtext token needed: YouTube renders the transcript
  // into the DOM. We open the panel, pick Russian if available, and read the text.
  function trackName(t) {
    return (t && t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || '';
  }
  function captionTracks() {
    const p = player();
    let pr = null;
    try { pr = p.getPlayerResponse(); } catch (e) {}
    // ytInitialPlayerResponse is NOT refreshed on in-site navigation — it still holds
    // the video the tab was opened with, so only trust it when it matches this video.
    if (!pr || !pr.captions) {
      const initial = window.ytInitialPlayerResponse;
      const initialId = initial && initial.videoDetails && initial.videoDetails.videoId;
      if (initialId && initialId === vidId()) pr = initial;
    }
    const tl = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    return (tl && tl.captionTracks) || [];
  }
  // YouTube ships TWO transcript UIs and which one a video gets varies:
  //  * legacy  — ytd-transcript-segment-renderer rows inside a panel whose target-id
  //              contains "transcript", with a language picker in its footer;
  //  * modern  — the "В этом видео" panel: transcript-segment-view-model rows, NO
  //              target-id on the panel and NO language picker at all.
  // Everything below therefore keys off the CONTENT (which rows exist), never off
  // panel ids or class names, and supports both layouts.
  function expandedTranscriptPanel() {
    return [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .find(p => p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' &&
                 (p.querySelector('transcript-segment-view-model') ||
                  p.querySelector('ytd-transcript-segment-renderer')));
  }
  // Rows are read ONLY from the panel that is currently open. After in-site navigation
  // YouTube can leave the previous video's panel in the DOM (hidden but still full of
  // its rows) — reading the document at large would hand back the old video's text.
  function modernSegments() {
    const panel = expandedTranscriptPanel();
    return panel ? [...panel.querySelectorAll('transcript-segment-view-model')] : [];
  }
  // For the legacy list the ACTIVE one is the last rendered: switching language appends
  // a new list and leaves the old one behind, so reading the last avoids duplicates.
  function legacySegmentList() {
    const panel = expandedTranscriptPanel();
    if (!panel) return null;
    const lists = panel.querySelectorAll('ytd-transcript-segment-list-renderer');
    const last = lists[lists.length - 1];
    return last && last.querySelector('ytd-transcript-segment-renderer') ? last : null;
  }
  function transcriptReady() {
    return modernSegments().length > 0 || !!legacySegmentList();
  }
  function isClickable(el) {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  // The control that opens the transcript. The modern layout calls it "Показать текст
  // видео" and puts it at the bottom of the description; the classic one says
  // "Расшифровка видео". Both labels are ALSO used by the tab chip inside the transcript
  // panel itself, which is invisible while that panel is closed — clicking it does
  // nothing, so only a genuinely clickable control counts.
  function findTranscriptButton() {
    return [...document.querySelectorAll('button, a[role="button"], [role="button"]')].find((b) => {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
      if (!/показать текст видео|показать расшифровку|расшифровка видео|show transcript|show video text/i.test(label)) return false;
      if (/закрыть|close|скрыть/i.test(label)) return false;
      return isClickable(b);
    });
  }
  // The modern panel groups "Эпизоды" and "Расшифровка видео" as tabs — if it opens on
  // the wrong tab there are no transcript rows until we switch to it.
  function activateTranscriptTab() {
    const panel = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .find(p => p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    if (!panel) return false;
    const tab = [...panel.querySelectorAll('button')].find(b =>
      /расшифровка видео|transcript/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    if (!tab) return false;
    try { tab.click(); return true; } catch (e) { return false; }
  }
  function closeTranscript() {
    // Scope to the transcript panel: the modern one labels its button just "Закрыть",
    // and that label is used by many other panels on the page.
    const panel = expandedTranscriptPanel();
    const inPanel = panel && [...panel.querySelectorAll('button')].find(b =>
      /закрыть|close/i.test(b.getAttribute('aria-label') || ''));
    const btn = inPanel || [...document.querySelectorAll('button')].find(b =>
      /закрыть расшифров|close transcript/i.test(b.getAttribute('aria-label') || ''));
    if (btn) { try { btn.click(); } catch (e) {} }
  }
  // One open attempt. Returns true when the transcript actually rendered segments.
  // YouTube sometimes lags and opens an empty panel — the caller retries.
  async function openTranscriptOnce() {
    if (transcriptReady()) return true;
    const scrollY = window.scrollY; // put the page back where the user left it
    try {
      let btn = findTranscriptButton();
      if (!btn) {
        // The transcript section sits at the end of the description and is only laid
        // out once the description is expanded — until then its button has no size.
        const more = document.querySelector('ytd-text-inline-expander #expand, #description #expand, tp-yt-paper-button#expand');
        if (isClickable(more)) { try { more.click(); } catch (e) {} await sleep(700); btn = findTranscriptButton(); }
      }
      if (!btn) {
        const anchor = document.querySelector('ytd-structured-description-content-renderer, #below, ytd-watch-metadata');
        if (anchor) { try { anchor.scrollIntoView({ block: 'end' }); } catch (e) {} await sleep(700); btn = findTranscriptButton(); }
      }
      if (!btn) return false; // no transcript control on this video
      try { btn.click(); } catch (e) {}
      for (let i = 0; i < 25 && !transcriptReady(); i++) await sleep(150);
      if (!transcriptReady() && activateTranscriptTab()) {
        for (let i = 0; i < 20 && !transcriptReady(); i++) await sleep(150);
      }
      return transcriptReady();
    } finally {
      try { window.scrollTo(0, scrollY); } catch (e) {}
    }
  }
  function transcriptLangLabel() {
    const panel = expandedTranscriptPanel();
    const f = panel && panel.querySelector('ytd-transcript-footer-renderer #label-text');
    return f ? f.textContent.trim() : '';
  }
  // Only the legacy panel lets us pick a language; the modern one shows whatever
  // YouTube picked and offers no control, so this is a no-op there.
  async function selectTranscriptLanguage(name) {
    if (!name || transcriptLangLabel() === name) return;
    const panel = expandedTranscriptPanel();
    const footer = panel && panel.querySelector('ytd-transcript-footer-renderer');
    const trigger = footer && footer.querySelector('tp-yt-paper-button');
    if (!trigger) return;
    try { trigger.click(); } catch (e) {}
    await sleep(600);
    const link = [...document.querySelectorAll('tp-yt-iron-dropdown a, tp-yt-paper-listbox a')]
      .filter(a => a.offsetParent !== null).find(a => a.textContent.trim() === name);
    if (!link) { try { trigger.click(); } catch (e) {} return; } // keep current language
    try { link.click(); } catch (e) {}
    for (let i = 0; i < 30 && transcriptLangLabel() !== name; i++) await sleep(150);
    await sleep(500); // let the new segment list render
  }
  function extractTranscriptText() {
    const lines = [];
    const push = (raw) => {
      const t = String(raw || '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) return;
      if (lines.length && lines[lines.length - 1] === t) return; // drop repeated cues
      lines.push(t);
    };
    const modern = modernSegments();
    if (modern.length) {
      // each row is [timestamp div][screen-reader label div][text span] — taking the
      // whole row's textContent would glue "0:00" and "0 секунд" onto the text
      for (const s of modern) {
        const span = s.querySelector('span');
        push(span ? span.textContent : (s.children[s.children.length - 1] || {}).textContent);
      }
      return lines;
    }
    const list = legacySegmentList();
    if (!list) return [];
    for (const s of list.querySelectorAll('ytd-transcript-segment-renderer')) {
      const tx = s.querySelector('.segment-text, yt-formatted-string.segment-text');
      if (tx) push(tx.textContent);
    }
    return lines;
  }
  async function getSubtitles() {
    const tracks = captionTracks();
    if (!tracks.length) throw new Error('у этого видео нет субтитров');
    // prefer manual ru, then auto ru; otherwise keep whatever the panel shows
    const ru = tracks.find(t => t.languageCode === 'ru' && t.kind !== 'asr')
            || tracks.find(t => t.languageCode === 'ru');
    const wantName = ru ? trackName(ru) : null;

    let lines = [], lastErr = null;
    // Retry: YouTube occasionally opens an empty transcript. Close + reopen fresh.
    for (let attempt = 0; attempt < 3 && !lines.length; attempt++) {
      if (attempt > 0) { closeTranscript(); await sleep(800); }
      try {
        if (!(await openTranscriptOnce())) { lastErr = new Error('расшифровка не загрузилась'); continue; }
        if (wantName) await selectTranscriptLanguage(wantName); // legacy panel only
        for (let i = 0; i < 20 && !extractTranscriptText().length; i++) await sleep(150);
        lines = extractTranscriptText();
      } catch (e) { lastErr = e; }
    }

    closeTranscript(); // we're done — leave the player as we found it
    if (!lines.length) throw new Error((lastErr && lastErr.message) || 'не удалось получить расшифровку');

    // Name the file after the language we actually got. The legacy panel states it;
    // the modern one doesn't, so fall back to the text itself (Cyrillic → ru) and
    // finally to the video's own caption list.
    let lang = 'txt';
    const byLabel = tracks.find(t => trackName(t) === transcriptLangLabel());
    if (byLabel) lang = byLabel.languageCode;
    else if (ru && /[Ѐ-ӿ]/.test(lines.slice(0, 30).join(' '))) lang = 'ru';
    else if (tracks.length === 1) lang = tracks[0].languageCode || 'txt';
    else lang = (tracks[0] && tracks[0].languageCode) || 'txt';

    return { text: lines.join('\n'), lang };
  }

  // ---- bridge to the isolated-world UI script ------------------------------
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__ytdl_to_hook !== true) return;
    const { cmd, reqId, height, format, start, end } = ev.data;
    const reply = (payload, transfer) => window.postMessage(
      Object.assign({ __ytdl_from_hook: true, reqId }, payload), '*', transfer || []);
    try {
      if (cmd === 'info') {
        const p = player();
        reply({
          ok: true, videoId: vidId(),
          title: (p && p.getVideoData && p.getVideoData().title) || document.title.replace(/ - YouTube$/, ''),
          duration: (video() && video().duration) || 0,
          heights: availableHeights(),
        });
      } else if (cmd === 'download') {
        // Any page script can forge bridge messages, so keep malformed input out of
        // the seek math and refuse nested captures (which would fight over the same
        // player and tracks). playthrough itself clamps to the video's duration;
        // here we only ensure the numbers are real.
        if (store.capturing) throw new Error('уже идёт захват — дождитесь завершения');
        const isMp3 = format === 'mp3';
        const s = Number(start), e = Number(end);
        if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error('неверный диапазон');
        // mp3 only needs audio → capture at a low but still-adaptive video quality
        // (360p) to save bandwidth while keeping video/audio as separate tracks.
        const targetQ = isMp3 ? 'medium' : (Q[height] || 'hd720');
        const cap = await playthrough(
          { targetQ, start: s, end: e, needVideo: !isMp3 },
          (pct) => reply({ progress: pct, phase: 'buffering' }));

        const aud = assemble('audio');
        if (!aud) throw new Error('не удалось захватить аудио');
        const payload = {
          ok: true, done: true,
          complete: !!cap.complete,         // false when capture broke (stall/cap/restart) — file may be cut
          restarts: cap.restarts || 0,     // mid-capture re-inits that CUT a track
          capturedFrom: cap.capturedFrom,   // where the captured file actually begins
          height: cap.actualH || 0,         // resolution the player actually served
          audio: { mime: aud.mime, size: aud.bytes.byteLength },
        };
        const transfers = [aud.bytes.buffer];
        payload._a = aud.bytes.buffer;
        if (!isMp3) {
          const vid = assemble('video');
          if (!vid) throw new Error('не удалось захватить видео');
          payload.video = { mime: vid.mime, size: vid.bytes.byteLength };
          payload._v = vid.bytes.buffer;
          transfers.push(vid.bytes.buffer);
        }
        reply(payload, transfers);
      } else if (cmd === 'subtitles') {
        const res = await getSubtitles();
        reply({ ok: true, done: true, text: res.text, lang: res.lang });
      }
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });

  document.addEventListener('yt-navigate-finish', () => {
    if (vidId() !== store.videoId) {
      store.videoId = vidId();
      resetTracks();
      store.lastInit = Object.create(null); // inits from the previous video are stale
      store.sb = Object.create(null);
      store.restarts = Object.create(null);
      store.capturing = false;
    }
    scheduleAutoplayOff();
  });

  // Disable "Autoplay next" as soon as the player controls exist (they render a bit
  // after load), and again after each navigation.
  function scheduleAutoplayOff() {
    let tries = 20;
    (function tick() {
      if (keepAutoplayOff() || tries-- <= 0) return;
      setTimeout(tick, 1000);
    })();
  }
  scheduleAutoplayOff();

  store.videoId = vidId();
  dbg('MSE capture hook installed');
})();
