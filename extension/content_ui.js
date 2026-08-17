// content_ui.js — isolated world. Draws the Triangle Downloader button + menu in
// the YouTube player, drives the MAIN-world capture hook over window.postMessage,
// then streams the captured tracks to the offscreen ffmpeg worker for muxing.
(function () {
  // Shared pure helpers (time / trim / base64 / filenames) — provided by lib/format.js,
  // which the manifest injects BEFORE this script in the same isolated world.
  const L = window.YTDL_LIB;
  const BTN_ID = 'ytdl-btn';
  // Clips up to this length get an exact (re-encoded) cut; longer ones are copied
  // instantly and start at the keyframe before the requested point. Re-encoding costs
  // roughly the clip's own length at 1080p, so ~1 minute is a comfortable ceiling.
  const EXACT_CUT_MAX_SEC = 60;
  // Long ranges are saved as sequential parts when the «По частям» toggle is on or the
  // adaptive warning suggests it. Each part is a full independent capture+mux, so memory
  // stays bounded to one part and the 20-minute capture hard cap is never hit.
  const PART_MAX_SEC = 15 * 60;   // ~15 min per part
  const PEAK_MULT = 4;            // offscreen keeps ~4 copies of the source in RAM
  const WARN_FRACTION = 0.25;     // warn when estimated peak > 25% of available RAM
  const MIN_EST_MB = 300;         // never warn for small downloads
  let reqSeq = 1;
  const pending = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__ytdl_from_hook !== true) return;
    const p = pending.get(ev.data.reqId);
    if (p) p(ev.data);
  });
  function callHook(cmd, extra) {
    return new Promise((resolve) => {
      const reqId = reqSeq++;
      pending.set(reqId, resolve);
      window.postMessage(Object.assign({ __ytdl_to_hook: true, cmd, reqId }, extra || {}), '*');
    });
  }
  // Reject if the hook never answers (e.g. it failed to install) instead of leaving
  // the menu hanging forever with no feedback.
  function withTimeout(p, ms, message) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }
  // download drives streaming progress + a final result
  function download(params, onProgress) {
    return new Promise((resolve, reject) => {
      const reqId = reqSeq++;
      const handler = (ev) => {
        if (ev.source !== window || !ev.data || ev.data.__ytdl_from_hook !== true || ev.data.reqId !== reqId) return;
        const d = ev.data;
        if (d.progress != null && !d.done) { onProgress(d); return; }
        window.removeEventListener('message', handler);
        if (d.ok && d.done) resolve(d); else reject(new Error(d.error || 'capture failed'));
      };
      window.addEventListener('message', handler);
      window.postMessage(Object.assign({ __ytdl_to_hook: true, cmd: 'download', reqId }, params), '*');
    });
  }

  // ---- dom helpers (no innerHTML — the page enforces Trusted Types) ---------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function triangleSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('fill', '#fff');
    path.setAttribute('d', 'M5 8 H19 L12 17 Z'); // centered downward triangle
    svg.appendChild(path);
    return svg;
  }

  // ---- button --------------------------------------------------------------
  function makeButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'ytp-button ytdl-btn';
    btn.title = 'Triangle Downloader';
    btn.appendChild(triangleSvg());
    btn.addEventListener('click', onClick);
    return btn;
  }
  function itemLabel(item, main, ext) {
    const b = el('b', null, main);
    item.appendChild(b);
    if (ext) { item.appendChild(document.createTextNode(' ')); item.appendChild(el('span', 'ytdl-ext', ext)); }
  }
  function ensureButton() {
    if (!/\/watch/.test(location.pathname)) return;
    if (document.getElementById(BTN_ID)) return;
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return;
    controls.insertBefore(makeButton(), controls.firstChild);
  }

  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; document.removeEventListener('click', onDocClick, true); } }
  function onDocClick(e) { if (menuEl && !menuEl.contains(e.target) && e.target.id !== BTN_ID) closeMenu(); }

  function head(text) { const d = document.createElement('div'); d.className = 'ytdl-menu-head'; d.textContent = text; return d; }

  // Rough VP9 bitrate estimates (Mbps) used ONLY to estimate capture size. Real bitrate
  // varies, so the estimate is conservative (high side). The offscreen document holds the
  // whole track in RAM several times over (PEAK_MULT) — that peak is what the adaptive
  // warning compares against the machine's actually available memory.
  const EST_MBPS = { 2160: 25, 1440: 12, 1080: 6, 720: 4 };
  const estimatedMB = (height, seconds) => ((EST_MBPS[height] || 6) * Math.max(0, seconds)) / 8;

  // Available RAM, cached for the session. Prefers the real value from the background
  // (chrome.system.memory, includes free capacity); falls back to navigator.deviceMemory,
  // which caps at 8 GB — the worst case is assumed.
  let memInfo = null; // { capacityMB, freeMB }
  async function getMemInfo() {
    if (memInfo) return memInfo;
    try {
      // withTimeout so a non-responding background can't hang the download click.
      const r = await withTimeout(chrome.runtime.sendMessage({ t: 'ytdl-mem' }), 2000, 'memory timeout');
      if (r && r.ok && r.free > 0) { memInfo = { capacityMB: r.capacity, freeMB: r.free }; return memInfo; }
    } catch (e) { /* background not reachable — fall through */ }
    const gb = navigator.deviceMemory || 8;
    memInfo = { capacityMB: gb * 1024, freeMB: gb * 1024 };
    return memInfo;
  }

  // Adaptive large-capture warning: returns 'parts' | 'single' | 'cancel' — or null when
  // the estimated peak RAM stays safely under WARN_FRACTION of the available memory.
  async function adaptiveWarning(height, start, end) {
    const estMB = estimatedMB(height, end - start);
    const peakMB = estMB * PEAK_MULT;
    if (estMB < MIN_EST_MB) return null;
    const mem = await getMemInfo();
    if (peakMB <= mem.freeMB * WARN_FRACTION) return null;
    const partCount = Math.ceil((end - start) / PART_MAX_SEC);
    const txt = 'Ролик ≈ ' + Math.round(estMB) + ' МБ, при муксинге понадобится до ~' +
      (peakMB / 1024).toFixed(1) + ' ГБ памяти.';
    if (partCount > 1) {
      return partsModal(txt + ' Рекомендую скачать по частям (' + partCount + ' × ~' +
        Math.round(PART_MAX_SEC / 60) + ' мин).');
    }
    return window.confirm(txt + ' Продолжить?') ? 'single' : 'cancel';
  }

  // Three-choice modal (parts / whole / cancel). Resolves with the chosen action.
  function partsModal(text) {
    return new Promise((resolve) => {
      const overlay = el('div', 'ytdl-modal');
      const box = el('div', 'ytdl-modal-box');
      box.appendChild(el('div', 'ytdl-modal-txt', text));
      const btns = el('div', 'ytdl-modal-btns');
      const cleanup = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
      };
      const mk = (label, cls, val) => {
        const b = el('button', 'ytdl-modal-btn' + (cls ? ' ' + cls : ''), label);
        b.addEventListener('click', () => { cleanup(); resolve(val); });
        btns.appendChild(b);
      };
      const onKey = (ev) => { if (ev.key === 'Escape') { cleanup(); resolve('cancel'); } };
      mk('Скачать по частям', 'primary', 'parts');
      mk('Целиком', '', 'single');
      mk('Отмена', 'cancel', 'cancel');
      box.appendChild(btns);
      overlay.appendChild(box);
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) { cleanup(); resolve('cancel'); } });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
    });
  }

  async function onClick(e) {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }
    let info;
    try {
      info = await withTimeout(callHook('info'), 4000, 'не удалось связаться с плеером');
    } catch (err) {
      const t = toast();
      t.set('Ошибка: ' + (err.message || err), 1);
      t.hide(5000);
      return;
    }
    const duration = Math.floor(info.duration || 0);
    // Show only the qualities the player actually reports as available — a missing
    // option means the video can't be captured at it, and a falsely-labelled file
    // (e.g. "[720p]" containing 360p) is worse than no option at all.
    const heights = (info.heights || []).filter((h) => h === 2160 || h === 1440 || h === 1080 || h === 720);
    const uniq = [...new Set(heights)].sort((a, b) => b - a);
    const { transcode = false, parts = false, mp3Bitrate = 192 } =
      await chrome.storage.local.get(['transcode', 'parts', 'mp3Bitrate']);
    // Radio/toggle state lives here (onClick scope) so the video/mp3 click handlers read
    // the CURRENT selection — passing the initial storage value would ignore a change made
    // in this menu session.
    let current = !!transcode;
    let partsOn = !!parts;    // «По частям» toggle — read at click time
    let mp3Bit = Number(mp3Bitrate) || 192; // kbps — only affects MP3 downloads

    menuEl = document.createElement('div');
    menuEl.className = 'ytdl-menu';

    menuEl.appendChild(head('Triangle Downloader'));

    // --- fragment selection ---
    const frag = document.createElement('div');
    frag.className = 'ytdl-frag';
    const inStart = document.createElement('input');
    const inEnd = document.createElement('input');
    inStart.className = inEnd.className = 'ytdl-time';
    inStart.value = L.fmtTime(0);
    inEnd.value = L.fmtTime(duration);
    [inStart, inEnd].forEach((i) => i.addEventListener('click', (ev) => ev.stopPropagation()));
    const dash = document.createElement('span'); dash.className = 'ytdl-frag-dash'; dash.textContent = '—';
    frag.appendChild(inStart); frag.appendChild(dash); frag.appendChild(inEnd);
    menuEl.appendChild(frag);

    function fragment() {
      let start = L.parseTime(inStart.value);
      let end = L.parseTime(inEnd.value);
      if (start == null) start = 0;
      if (end == null || end <= 0) end = duration;
      start = Math.max(0, Math.min(start, duration));
      end = Math.max(start + 1, Math.min(end, duration));
      return { start, end };
    }

    // --- video (only when at least one quality is available) ---
    if (uniq.length) {
      menuEl.appendChild(head('Видео'));
      uniq.forEach((h) => {
        const item = el('div', 'ytdl-menu-item');
        itemLabel(item, h + 'p', 'mp4');
        item.addEventListener('click', async () => {
          const f = fragment(); closeMenu();
          const range = f.end - f.start;
          // Toggle on → always split long ranges; otherwise the adaptive warning may
          // suggest parts for a large capture.
          const parts = partsOn && range > PART_MAX_SEC ? L.splitRange(f.start, f.end, PART_MAX_SEC) : null;
          if (parts) { startParts({ format: 'mp4', height: h }, info, current, parts); return; }
          const decision = await adaptiveWarning(h, f.start, f.end);
          if (decision === 'cancel') return;
          if (decision === 'parts') {
            startParts({ format: 'mp4', height: h }, info, current, L.splitRange(f.start, f.end, PART_MAX_SEC));
            return;
          }
          startDownload({ format: 'mp4', height: h, start: f.start, end: f.end }, info, current);
        });
        menuEl.appendChild(item);
      });
    }

    // --- audio ---
    menuEl.appendChild(head('Аудио'));
    const mp3 = el('div', 'ytdl-menu-item');
    itemLabel(mp3, 'MP3', 'аудио');
    mp3.addEventListener('click', async () => {
      const f = fragment(); closeMenu();
      const range = f.end - f.start;
      // mp3 is tiny memory-wise; the toggle only matters to stay under the capture time cap.
      if (partsOn && range > PART_MAX_SEC) {
        startParts({ format: 'mp3', height: null, mp3Bitrate: mp3Bit }, info, current, L.splitRange(f.start, f.end, PART_MAX_SEC));
        return;
      }
      startDownload({ format: 'mp3', height: null, start: f.start, end: f.end, mp3Bitrate: mp3Bit }, info, current);
    });
    menuEl.appendChild(mp3);

    // --- subtitles (whole video; fragment does not apply) ---
    menuEl.appendChild(head('Субтитры'));
    const subs = el('div', 'ytdl-menu-item');
    itemLabel(subs, '.txt', 'рус / доступный');
    subs.addEventListener('click', () => { closeMenu(); downloadSubtitles(info); });
    menuEl.appendChild(subs);

    // --- video format toggle (only meaningful when video options exist) ---
    if (uniq.length) {
      menuEl.appendChild(head('Формат видео'));
      const formats = [
        { key: false, title: 'Быстро', sub: 'VP9 в mp4, без перекодирования' },
        { key: true, title: 'H.264 (совместимо)', sub: 'перекодирование, медленно' },
      ];
      const rows = [];
      formats.forEach((f) => {
        const row = el('div', 'ytdl-menu-radio' + (current === f.key ? ' sel' : ''));
        row.appendChild(el('span', 'ytdl-dot'));
        const txt = el('span', 'ytdl-radio-txt');
        txt.appendChild(el('b', null, f.title));
        txt.appendChild(el('i', null, f.sub));
        row.appendChild(txt);
        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          current = f.key;
          chrome.storage.local.set({ transcode: f.key });
          rows.forEach((r, i) => r.classList.toggle('sel', formats[i].key === current));
        });
        rows.push(row);
        menuEl.appendChild(row);
      });
      // --- «По частям» toggle: long ranges become sequential ~15-min files ---
      const partsRow = el('div', 'ytdl-menu-radio' + (partsOn ? ' sel' : ''));
      partsRow.appendChild(el('span', 'ytdl-dot'));
      const partsTxt = el('span', 'ytdl-radio-txt');
      partsTxt.appendChild(el('b', null, 'По частям'));
      partsTxt.appendChild(el('i', null, 'длинные ролики — по ~' + Math.round(PART_MAX_SEC / 60) + ' мин'));
      partsRow.appendChild(partsTxt);
      partsRow.addEventListener('click', (ev) => {
        ev.stopPropagation();
        partsOn = !partsOn;
        chrome.storage.local.set({ parts: partsOn });
        partsRow.classList.toggle('sel', partsOn);
      });
      menuEl.appendChild(partsRow);
    }

    // --- MP3 bitrate: only affects MP3 downloads; default 192k matches the original ---
    menuEl.appendChild(head('MP3 битрейт'));
    const bitrates = [
      { key: 192, title: '192 kbps', sub: 'как в оригинале' },
      { key: 320, title: '320 kbps', sub: 'максимальное качество, файл больше' },
    ];
    const bitRows = [];
    bitrates.forEach((b) => {
      const row = el('div', 'ytdl-menu-radio' + (mp3Bit === b.key ? ' sel' : ''));
      row.appendChild(el('span', 'ytdl-dot'));
      const txt = el('span', 'ytdl-radio-txt');
      txt.appendChild(el('b', null, b.title));
      txt.appendChild(el('i', null, b.sub));
      row.appendChild(txt);
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        mp3Bit = b.key;
        chrome.storage.local.set({ mp3Bitrate: b.key });
        bitRows.forEach((r, i) => r.classList.toggle('sel', bitrates[i].key === mp3Bit));
      });
      bitRows.push(row);
      menuEl.appendChild(row);
    });

    document.body.appendChild(menuEl);
    const b = document.getElementById(BTN_ID).getBoundingClientRect();
    menuEl.style.right = Math.max(8, window.innerWidth - b.right) + 'px';
    menuEl.style.bottom = (window.innerHeight - b.top + 8) + 'px';
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  }

  // ---- progress toast ------------------------------------------------------
  function toast() {
    let box = document.getElementById('ytdl-toast');
    let hideTimer = null;
    if (!box) {
      box = el('div'); box.id = 'ytdl-toast';
      const bar = el('div', 'ytdl-toast-bar'); bar.appendChild(el('i'));
      box.appendChild(bar);
      box.appendChild(el('span', 'ytdl-toast-txt'));
      document.body.appendChild(box);
    }
    return {
      set(txt, pct) {
        // A new message cancels any pending hide so a stale timer (e.g. from the
        // previous part of a split download) can't hide the toast mid-part.
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        box.querySelector('.ytdl-toast-txt').textContent = txt;
        box.querySelector('.ytdl-toast-bar i').style.width = Math.round((pct || 0) * 100) + '%';
        box.classList.add('show');
      },
      hide(delay) {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { hideTimer = null; box.classList.remove('show'); }, delay || 0);
      },
    };
  }

  async function downloadSubtitles(info) {
    const t = toast();
    t.set('Открываю расшифровку…', 0.3);
    try {
      const res = await callHook('subtitles');
      if (!res || !res.ok) throw new Error((res && res.error) || 'нет субтитров');
      const filename = L.safeName(info.title) + ' [' + (res.lang || 'txt') + '].txt';
      // small text → a data URL is enough; BOM keeps Cyrillic correct on Windows
      const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent('﻿' + res.text);
      const save = await chrome.runtime.sendMessage({ t: 'ytdl-save', url, filename });
      if (!save || !save.ok) throw new Error((save && save.error) || 'не удалось сохранить');
      t.set('Готово: ' + filename, 1);
      t.hide(4000);
    } catch (err) {
      t.set('Ошибка: ' + (err.message || err), 1);
      t.hide(6000);
      console.error('[Triangle]', err);
    }
  }

  // Download one concrete range (used for single downloads AND for one part of a split).
  // Shows per-step progress in `t` prefixed with `prefix` (e.g. "Часть 2 из 4: ") and
  // returns { ok } / { ok: false, error } instead of raising.
  async function downloadOne(opts, info, transcode, t, prefix) {
    const { format, height, start, end, mp3Bitrate } = opts;
    const duration = Math.floor(info.duration || 0);
    const isMp3 = format === 'mp3';
    const label = isMp3 ? 'MP3' : height + 'p';

    const onProg = (msg) => {
      if (msg && msg.t === 'ytdl-progress') {
        t.set(prefix + (isMp3 ? 'Кодирование MP3… ' : 'Точная обрезка (перекодирование)… ') +
          Math.round(msg.value * 100) + '%', 0.55 + msg.value * 0.45);
      }
    };
    chrome.runtime.onMessage.addListener(onProg);
    try {
      const result = await download({ height, format, start, end }, (d) => {
        t.set(prefix + 'Загрузка сегментов ' + label + '… ' + Math.round(d.progress * 100) + '%', d.progress * 0.5);
      });

      const ext = isMp3 ? '.mp3' : '.mp4';
      // The player may serve a lower resolution than requested (ABR/viewport cap) —
      // name the file after what we actually got so it isn't misleading, and note it
      // in the toast below.
      const actualH = result.height || 0;
      const downgraded = !isMp3 && actualH >= 100 && actualH < height;
      const effH = downgraded ? actualH : height;
      const filename = L.safeName(info.title) + (isMp3 ? '' : ' [' + effH + 'p]') +
        (opts.partLabel || L.fragSuffix(start, end, duration)) + ext;

      // Capture starts at a segment boundary at or before `start`, so trimming must be
      // RELATIVE to the captured file — ffmpeg's -ss counts from the file's own start,
      // not from the video's absolute timeline.
      const capturedFrom = typeof result.capturedFrom === 'number' ? result.capturedFrom : start;
      const job = L.computeJob({ start, end, duration, capturedFrom, isMp3, transcode, exactCutMaxSec: EXACT_CUT_MAX_SEC });
      const { trimStart, trimDuration, isFragment, exactCut, doTranscode, alignedStart, quickEncode } = job;

      t.set(prefix + (isMp3 ? 'Кодирование MP3…'
        : (exactCut ? 'Точная обрезка фрагмента (перекодирование)…'
          : (transcode ? 'Перекодирование в H.264 (может занять дольше ролика)…'
            : 'Склейка дорожек…'))), 0.55);

      const res = await muxViaOffscreen({
        format,
        video: isMp3 ? null : result._v,
        audio: result._a,
        videoMime: result.video && result.video.mime,
        audioMime: result.audio && result.audio.mime,
        filename, transcode: doTranscode, quickEncode,
        trimStart,
        // only limit duration when a real fragment was requested
        trimDuration: isFragment ? trimDuration : 0,
        mp3Bitrate,
      });

      if (!res || !res.ok) throw new Error(res && res.error || 'mux failed');
      const partialNote = result.complete === false
        ? (result.restarts > 0
            ? ' — во время захвата переключилось качество, файл может быть обрезан'
            : ' — захват неполный, файл может быть обрезан')
        : '';
      const resNote = downgraded ? ' — плеер отдал ' + actualH + 'p вместо ' + height + 'p' : '';
      t.set(prefix + 'Готово: ' + (res.filename || filename) +
        (alignedStart ? ' — начало выровнено по опорному кадру' : '') + partialNote + resNote, 1);
      t.hide(alignedStart || partialNote || resNote ? 7000 : 4000);
      return { ok: true };
    } catch (err) {
      t.set(prefix + 'Ошибка: ' + (err.message || err), 1);
      t.hide(7000);
      console.error('[Triangle]', err);
      return { ok: false, error: (err && err.message) || String(err) };
    } finally {
      chrome.runtime.onMessage.removeListener(onProg);
    }
  }

  // Save a long range as sequential parts — one independent file per part.
  async function startParts(base, info, transcode, parts) {
    const { format, height, mp3Bitrate } = base;
    const label = format === 'mp3' ? 'MP3' : height + 'p';
    const t = toast();
    t.set('Скачивание по частям: 0 из ' + parts.length + '…', 0.02);
    let failed = null;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      // Emit an immediate per-part message so the toast never goes blank between
      // parts (the first capture progress callback is seconds away).
      t.set('Часть ' + (i + 1) + ' из ' + parts.length + ': готовлю ' + label + '…', 0.02);
      const r = await downloadOne({
        format, height, start: p.start, end: p.end,
        mp3Bitrate,
        partLabel: ' (part ' + (i + 1) + ' of ' + parts.length + ')',
      }, info, transcode, t, 'Часть ' + (i + 1) + ' из ' + parts.length + ': ');
      if (!r.ok) { failed = { index: i + 1, error: r.error }; break; }
    }
    if (failed) {
      t.set('Ошибка в части ' + failed.index + ': ' + failed.error, 1);
      t.hide(8000);
    } else {
      t.set('Готово: ' + parts.length + ' частей (' + label + ')', 1);
      t.hide(6000);
    }
  }

  // Single-download entry point (parts are handled by startParts / the click handlers).
  async function startDownload(opts, info, transcode) {
    const { format, height } = opts;
    const t = toast();
    t.set('Готовлю ' + (format === 'mp3' ? 'MP3' : height + 'p') + ' — загрузка сегментов…', 0.02);
    await downloadOne(opts, info, transcode, t, '');
  }

  // ---- transfer to offscreen ffmpeg ---------------------------------------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // The ffmpeg side lives in an offscreen document that the service worker creates on
  // demand. Only that document answers begin/chunk/finalize, so sending before it is
  // listening rejects with a bare "message port closed". Wait for it to answer a ping
  // first — and give a failed send one more try, since the worker may have been asleep.
  async function offscreenReady(timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await chrome.runtime.sendMessage({ t: 'ytdl-ping' });
        if (r && r.ok) return true;
      } catch (e) { /* not listening yet */ }
      await wait(200);
    }
    return false;
  }

  async function sendToOffscreen(msg, retries = 1) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await chrome.runtime.sendMessage(msg);
        if (r) return r;                     // includes negative answers — those are real
        lastErr = new Error('нет ответа от обработчика');
      } catch (e) { lastErr = e; }
      if (attempt < retries) {
        try { await chrome.runtime.sendMessage({ t: 'ytdl-ensure' }); } catch (e) {}
        await wait(300);
      }
    }
    throw lastErr || new Error('обработчик ffmpeg не отвечает');
  }

  async function muxViaOffscreen(job) {
    const CHUNK = 4 * 1024 * 1024;
    await chrome.runtime.sendMessage({ t: 'ytdl-ensure' });
    if (!await offscreenReady()) throw new Error('обработчик ffmpeg не запустился');

    await sendToOffscreen({
      t: 'ytdl-begin', filename: job.filename, format: job.format,
      videoMime: job.videoMime, audioMime: job.audioMime,
      transcode: !!job.transcode, quickEncode: !!job.quickEncode,
      trimStart: job.trimStart || 0, trimDuration: job.trimDuration || 0,
      mp3Bitrate: job.mp3Bitrate, // default (192) is owned by the offscreen side
    });

    let seq = 0; // lets the receiver drop a repeated chunk instead of doubling the data
    const sendTrack = async (name, buf) => {
      if (!buf) return;
      const view = new Uint8Array(buf);
      for (let off = 0; off < view.length; off += CHUNK) {
        const slice = view.subarray(off, Math.min(off + CHUNK, view.length));
        const r = await sendToOffscreen({ t: 'ytdl-chunk', track: name, seq, b64: L.b64encode(slice) });
        if (!r || !r.ok) {
          throw new Error('передача данных прервалась (' + name + ')' + (r && r.error ? ': ' + r.error : ''));
        }
        seq++;
      }
    };
    await sendTrack('video', job.video);
    await sendTrack('audio', job.audio);
    // No retry here: a repeated finalize would re-run ffmpeg on already-freed data.
    return sendToOffscreen({ t: 'ytdl-finalize' }, 0);
  }

  const mo = new MutationObserver(() => ensureButton());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', ensureButton);
  ensureButton();
})();
