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
    tracks: Object.create(null), // kind -> { mime, parts: Uint8Array[] }
  };

  function vidId() { try { return new URLSearchParams(location.search).get('v'); } catch (e) { return null; } }
  function resetTracks() { store.tracks = Object.create(null); }

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
    } catch (e) {}
    return sb;
  };

  const OrigAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      if (store.capturing) {
        const kind = this.__ytdlKind;
        if (kind === 'video' || kind === 'audio') {
          const u8 = u8of(data);
          if (u8 && u8.length) {
            let t = store.tracks[kind];
            if (!t) {
              // wait for the track's init chunk before we start concatenating
              if (startsWithInit(u8)) t = store.tracks[kind] = { mime: this.__ytdlMime || '', parts: [] };
            }
            if (t) t.parts.push(u8.slice());
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

  // ---- player helpers ------------------------------------------------------
  function player() { return document.getElementById('movie_player'); }
  function video() { return document.querySelector('video'); }
  const Q = { 1080: 'hd1080', 720: 'hd720' };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function setQualityRaw(q) {
    const p = player();
    try { p.setPlaybackQualityRange && p.setPlaybackQualityRange(q, q); } catch (e) {}
    try { p.setPlaybackQuality && p.setPlaybackQuality(q); } catch (e) {}
  }
  function availableHeights() {
    try {
      const map = { hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240 };
      return (player().getAvailableQualityLevels() || []).map(l => map[l]).filter(Boolean);
    } catch (e) { return []; }
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

  // Turn off "autoplay next" so reaching the end can't navigate away. Returns a
  // function that restores the previous state, or null if nothing was changed.
  function disableAutoplay() {
    try {
      const btn = document.querySelector('.ytp-autonav-toggle-button');
      if (btn && btn.getAttribute('aria-checked') === 'true') {
        btn.click();
        return () => {
          try {
            const b = document.querySelector('.ytp-autonav-toggle-button');
            if (b && b.getAttribute('aria-checked') !== 'true') b.click();
          } catch (e) {}
        };
      }
    } catch (e) {}
    return null;
  }

  // Capture the whole selected quality by playing forward fast. The browser
  // buffers ahead of the playhead, so we keep the playhead safely BEFORE the end
  // (never triggering the end / autoplay-next) and just wait for the buffer to
  // cover the whole duration. Capture aborts if the page navigates to another video.
  async function playthrough(opts, onProgress) {
    const targetQ = opts.targetQ;   // e.g. 'hd1080' / 'small'
    const preQ = opts.preQ;         // a DIFFERENT low quality, to force a fresh init
    const needVideo = opts.needVideo !== false; // mp3 only needs audio
    const v = video();
    const dur = v.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error('duration unknown');
    const capEnd = Math.min(opts.end && opts.end > 0 ? opts.end : dur, dur);
    const capId = vidId();

    const prev = { paused: v.paused, rate: v.playbackRate, time: v.currentTime, muted: v.muted };
    const restoreAutoplay = disableAutoplay();
    try { v.muted = true; } catch (e) {}
    try { v.pause(); } catch (e) {}

    // Order matters:
    //  1) switch to a low quality and SEEK TO 0 first, so the whole capture starts
    //     from the very beginning of the video (not from wherever the user was).
    //  2) then start recording and switch to the target quality — its init segment
    //     is appended at position 0 while we record. record() only begins a track
    //     on its init chunk, so leftover low-quality fragments are ignored.
    setQualityRaw(preQ);
    await sleep(500);
    seekVia(0);
    await sleep(500);
    resetTracks();
    store.capturing = true;
    setQualityRaw(targetQ);
    seekVia(0);
    await sleep(400);

    // wait until the tracks we need have their init before entering the capture loop
    const haveInits = () => store.tracks.audio && (!needVideo || store.tracks.video);
    for (let i = 0; i < 40 && !haveInits(); i++) await sleep(150);

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
    let cursor = 0, stall = 0;
    const started = Date.now();
    try {
      try { v.pause(); } catch (e) {}
      while (true) {
        await sleep(350);
        if (vidId() !== capId) throw new Error('видео переключилось во время захвата');
        try { if (!v.paused) v.pause(); } catch (e) {} // keep it paused; buffering runs anyway

        const edge = bufferedEndAt(cursor);
        onProgress(Math.min(0.99, edge / capEnd));
        if (edge >= capEnd - 0.6) break;                 // fully buffered → captured

        if (edge > cursor + 0.3) {                       // window extended → hop to the edge
          cursor = edge;
          seekVia(Math.min(cursor, capEnd - 0.1));
          stall = 0;
        } else {                                         // plateaued → nudge to re-trigger fetch
          stall++;
          if (stall % 4 === 0) seekVia(Math.min(cursor + 0.1, capEnd - 0.1));
          if (stall >= 60) break;                        // ~21s with no progress → give up
        }
        if (Date.now() - started > 20 * 60 * 1000) break; // hard cap
      }
    } finally {
      store.capturing = false;
      // restore player state
      try { v.playbackRate = prev.rate; } catch (e) {}
      seekVia(prev.time);
      try { v.muted = prev.muted; } catch (e) {}
      if (restoreAutoplay) restoreAutoplay();
      if (!prev.paused) { try { v.play(); } catch (e) {} }
    }
    onProgress(1);
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
    if (!pr || !pr.captions) pr = window.ytInitialPlayerResponse;
    const tl = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
    return (tl && tl.captionTracks) || [];
  }
  function expandedTranscriptPanel() {
    return [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .find(p => (p.getAttribute('target-id') || '').includes('transcript') &&
                 p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  }
  // the ACTIVE segment list is the last one rendered (switching language appends a
  // new list and leaves the old one behind — reading the last avoids duplicates)
  function activeTranscriptList() {
    const lists = document.querySelectorAll('ytd-transcript-segment-list-renderer');
    const last = lists[lists.length - 1];
    return last && last.querySelector('ytd-transcript-segment-renderer') ? last : null;
  }
  function findTranscriptButton() {
    return [...document.querySelectorAll('button')].find(b => {
      const a = b.getAttribute('aria-label') || '';
      return /расшифровка видео|show transcript/i.test(a) && !/закрыть|close/i.test(a);
    });
  }
  function findCloseTranscriptButton() {
    return [...document.querySelectorAll('button')].find(b =>
      /закрыть расшифров|close transcript/i.test(b.getAttribute('aria-label') || ''));
  }
  function closeTranscript() {
    const btn = findCloseTranscriptButton();
    if (btn) { try { btn.click(); } catch (e) {} }
  }
  // One open attempt. Returns true when the transcript actually rendered segments.
  // YouTube sometimes lags and opens an empty panel — the caller retries.
  async function openTranscriptOnce() {
    if (activeTranscriptList()) return true;
    let btn = findTranscriptButton();
    if (!btn) { // the button may live inside the collapsed description
      const more = document.querySelector('ytd-text-inline-expander #expand, #description #expand, tp-yt-paper-button#expand');
      if (more) { try { more.click(); } catch (e) {} await sleep(500); btn = findTranscriptButton(); }
    }
    if (!btn) return false; // no transcript button on this video
    try { btn.click(); } catch (e) {}
    for (let i = 0; i < 40 && !activeTranscriptList(); i++) await sleep(150);
    return !!activeTranscriptList();
  }
  function transcriptLangLabel() {
    const panel = expandedTranscriptPanel();
    const f = panel && panel.querySelector('ytd-transcript-footer-renderer #label-text');
    return f ? f.textContent.trim() : '';
  }
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
    const list = activeTranscriptList();
    if (!list) return [];
    const lines = [];
    for (const s of list.querySelectorAll('ytd-transcript-segment-renderer')) {
      const tx = s.querySelector('.segment-text, yt-formatted-string.segment-text');
      if (!tx) continue;
      const t = tx.textContent.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (lines.length && lines[lines.length - 1] === t) continue; // drop repeated cues
      lines.push(t);
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

    let lines = [], lang = ru ? 'ru' : 'txt', lastErr = null;
    // Retry: YouTube occasionally opens an empty transcript. Close + reopen fresh.
    for (let attempt = 0; attempt < 3 && !lines.length; attempt++) {
      if (attempt > 0) { closeTranscript(); await sleep(800); }
      try {
        if (!(await openTranscriptOnce())) { lastErr = new Error('расшифровка не загрузилась'); continue; }
        if (wantName) await selectTranscriptLanguage(wantName);
        for (let i = 0; i < 20 && !extractTranscriptText().length; i++) await sleep(150);
        lines = extractTranscriptText();
        if (lines.length && !ru) {
          const match = tracks.find(t => trackName(t) === transcriptLangLabel());
          lang = (match && match.languageCode) || (tracks[0].languageCode) || 'txt';
        }
      } catch (e) { lastErr = e; }
    }

    closeTranscript(); // we're done — leave the player as we found it
    if (!lines.length) throw new Error((lastErr && lastErr.message) || 'не удалось получить расшифровку');
    return { text: lines.join('\n'), lang };
  }

  // ---- bridge to the isolated-world UI script ------------------------------
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__ytdl_to_hook !== true) return;
    const { cmd, reqId, height, format, end } = ev.data;
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
        const isMp3 = format === 'mp3';
        // mp3 only needs audio → capture at a low but still-adaptive video quality
        // (360p) to save bandwidth while keeping video/audio as separate tracks.
        const targetQ = isMp3 ? 'medium' : (Q[height] || 'hd720');
        const preQ = (targetQ === 'small' || targetQ === 'tiny' || targetQ === 'medium') ? 'tiny' : 'medium';
        await playthrough(
          { targetQ, preQ, end, needVideo: !isMp3 },
          (pct) => reply({ progress: pct, phase: 'buffering' }));

        const aud = assemble('audio');
        if (!aud) throw new Error('не удалось захватить аудио');
        const payload = { ok: true, done: true, audio: { mime: aud.mime, size: aud.bytes.byteLength } };
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
    if (vidId() !== store.videoId) { store.videoId = vidId(); resetTracks(); store.capturing = false; }
  });
  store.videoId = vidId();
  console.log('[YTDL] MSE capture hook installed');
})();
