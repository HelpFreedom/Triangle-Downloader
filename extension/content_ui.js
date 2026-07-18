// content_ui.js — isolated world. Draws the Triangle Downloader button + menu in
// the YouTube player, drives the MAIN-world capture hook over window.postMessage,
// then streams the captured tracks to the offscreen ffmpeg worker for muxing.
(function () {
  const BTN_ID = 'ytdl-btn';
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

  // ---- time helpers --------------------------------------------------------
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h + ':' + pad(m) + ':' + pad(s);
  }
  function parseTime(str) {
    const parts = String(str).trim().split(':').map((p) => Number(p));
    if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
    let s = 0; for (const p of parts) s = s * 60 + p;
    return s;
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

  async function onClick(e) {
    e.stopPropagation();
    if (menuEl) { closeMenu(); return; }
    const info = await callHook('info');
    const duration = Math.floor(info.duration || 0);
    const heights = (info.heights || []).filter((h) => h === 1080 || h === 720);
    if (!heights.includes(1080)) heights.unshift(1080);
    if (!heights.includes(720)) heights.push(720);
    const uniq = [...new Set(heights)].sort((a, b) => b - a);
    const { transcode = false } = await chrome.storage.local.get('transcode');

    menuEl = document.createElement('div');
    menuEl.className = 'ytdl-menu';

    menuEl.appendChild(head('Triangle Downloader'));

    // --- fragment selection ---
    const frag = document.createElement('div');
    frag.className = 'ytdl-frag';
    const inStart = document.createElement('input');
    const inEnd = document.createElement('input');
    inStart.className = inEnd.className = 'ytdl-time';
    inStart.value = fmtTime(0);
    inEnd.value = fmtTime(duration);
    [inStart, inEnd].forEach((i) => i.addEventListener('click', (ev) => ev.stopPropagation()));
    const dash = document.createElement('span'); dash.className = 'ytdl-frag-dash'; dash.textContent = '—';
    frag.appendChild(inStart); frag.appendChild(dash); frag.appendChild(inEnd);
    menuEl.appendChild(frag);

    function fragment() {
      let start = parseTime(inStart.value);
      let end = parseTime(inEnd.value);
      if (start == null) start = 0;
      if (end == null || end <= 0) end = duration;
      start = Math.max(0, Math.min(start, duration));
      end = Math.max(start + 1, Math.min(end, duration));
      return { start, end };
    }

    // --- video ---
    menuEl.appendChild(head('Видео'));
    uniq.forEach((h) => {
      const item = el('div', 'ytdl-menu-item');
      itemLabel(item, h + 'p', 'mp4');
      item.addEventListener('click', () => {
        const f = fragment(); closeMenu();
        startDownload({ format: 'mp4', height: h, start: f.start, end: f.end }, info);
      });
      menuEl.appendChild(item);
    });

    // --- audio ---
    menuEl.appendChild(head('Аудио'));
    const mp3 = el('div', 'ytdl-menu-item');
    itemLabel(mp3, 'MP3', 'аудио');
    mp3.addEventListener('click', () => {
      const f = fragment(); closeMenu();
      startDownload({ format: 'mp3', height: null, start: f.start, end: f.end }, info);
    });
    menuEl.appendChild(mp3);

    // --- subtitles (whole video; fragment does not apply) ---
    menuEl.appendChild(head('Субтитры'));
    const subs = el('div', 'ytdl-menu-item');
    itemLabel(subs, '.txt', 'рус / доступный');
    subs.addEventListener('click', () => { closeMenu(); downloadSubtitles(info); });
    menuEl.appendChild(subs);

    // --- video format toggle ---
    menuEl.appendChild(head('Формат видео'));
    const formats = [
      { key: false, title: 'Быстро', sub: 'VP9 в mp4, без перекодирования' },
      { key: true, title: 'H.264 (совместимо)', sub: 'перекодирование, медленно' },
    ];
    let current = !!transcode;
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

    document.body.appendChild(menuEl);
    const b = document.getElementById(BTN_ID).getBoundingClientRect();
    menuEl.style.right = Math.max(8, window.innerWidth - b.right) + 'px';
    menuEl.style.bottom = (window.innerHeight - b.top + 8) + 'px';
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  }

  // ---- progress toast ------------------------------------------------------
  function toast() {
    let box = document.getElementById('ytdl-toast');
    if (!box) {
      box = el('div'); box.id = 'ytdl-toast';
      const bar = el('div', 'ytdl-toast-bar'); bar.appendChild(el('i'));
      box.appendChild(bar);
      box.appendChild(el('span', 'ytdl-toast-txt'));
      document.body.appendChild(box);
    }
    return {
      set(txt, pct) {
        box.querySelector('.ytdl-toast-txt').textContent = txt;
        box.querySelector('.ytdl-toast-bar i').style.width = Math.round((pct || 0) * 100) + '%';
        box.classList.add('show');
      },
      hide(delay) { setTimeout(() => box.classList.remove('show'), delay || 0); },
    };
  }

  function safeName(s) {
    return (s || 'video').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  function fragSuffix(start, end, duration) {
    if (start <= 0 && end >= duration - 0.5) return '';
    return ' (' + fmtTime(start).replace(/:/g, '.') + '-' + fmtTime(end).replace(/:/g, '.') + ')';
  }

  async function downloadSubtitles(info) {
    const t = toast();
    t.set('Открываю расшифровку…', 0.3);
    try {
      const res = await callHook('subtitles');
      if (!res || !res.ok) throw new Error((res && res.error) || 'нет субтитров');
      const filename = safeName(info.title) + ' [' + (res.lang || 'txt') + '].txt';
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

  async function startDownload(opts, info) {
    const { format, height, start, end } = opts;
    const duration = Math.floor(info.duration || 0);
    const isMp3 = format === 'mp3';
    const label = isMp3 ? 'MP3' : height + 'p';
    const t = toast();
    t.set('Готовлю ' + label + ' — загрузка сегментов…', 0.02);

    const { transcode = false } = await chrome.storage.local.get('transcode');
    const doTranscode = isMp3 ? true : !!transcode; // mp3 always encodes

    const onProg = (msg) => {
      if (msg && msg.t === 'ytdl-progress') {
        t.set((isMp3 ? 'Кодирование MP3… ' : 'Перекодирование в H.264/AAC… ') +
          Math.round(msg.value * 100) + '%', 0.55 + msg.value * 0.45);
      }
    };
    chrome.runtime.onMessage.addListener(onProg);
    try {
      const result = await download({ height, format, end }, (d) => {
        t.set('Загрузка сегментов ' + label + '… ' + Math.round(d.progress * 100) + '%', d.progress * 0.5);
      });
      t.set(isMp3 ? 'Кодирование MP3…'
        : (transcode ? 'Готовлю перекодирование (может занять дольше ролика)…' : 'Склейка дорожек…'), 0.55);

      const ext = isMp3 ? '.mp3' : '.mp4';
      const filename = safeName(info.title) + (isMp3 ? '' : ' [' + height + 'p]') +
        fragSuffix(start, end, duration) + ext;

      const res = await muxViaOffscreen({
        format,
        video: isMp3 ? null : result._v,
        audio: result._a,
        videoMime: result.video && result.video.mime,
        audioMime: result.audio && result.audio.mime,
        filename, transcode: doTranscode, start, end,
      });

      if (!res || !res.ok) throw new Error(res && res.error || 'mux failed');
      t.set('Готово: ' + (res.filename || filename), 1);
      t.hide(4000);
    } catch (err) {
      t.set('Ошибка: ' + (err.message || err), 1);
      t.hide(6000);
      console.error('[Triangle]', err);
    } finally {
      chrome.runtime.onMessage.removeListener(onProg);
    }
  }

  // ---- transfer to offscreen ffmpeg ---------------------------------------
  function b64encode(u8) {
    let s = '';
    const STEP = 0x8000;
    for (let i = 0; i < u8.length; i += STEP) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + STEP, u8.length)));
    }
    return btoa(s);
  }

  async function muxViaOffscreen(job) {
    const CHUNK = 4 * 1024 * 1024;
    await chrome.runtime.sendMessage({ t: 'ytdl-ensure' });
    await chrome.runtime.sendMessage({
      t: 'ytdl-begin', filename: job.filename, format: job.format,
      videoMime: job.videoMime, audioMime: job.audioMime,
      transcode: !!job.transcode, start: job.start, end: job.end,
    });
    const sendTrack = async (name, buf) => {
      if (!buf) return;
      const view = new Uint8Array(buf);
      for (let off = 0; off < view.length; off += CHUNK) {
        const slice = view.subarray(off, Math.min(off + CHUNK, view.length));
        const r = await chrome.runtime.sendMessage({ t: 'ytdl-chunk', track: name, b64: b64encode(slice) });
        if (!r || !r.ok) throw new Error('передача данных прервалась (' + name + ')');
      }
    };
    await sendTrack('video', job.video);
    await sendTrack('audio', job.audio);
    return chrome.runtime.sendMessage({ t: 'ytdl-finalize' });
  }

  const mo = new MutationObserver(() => ensureButton());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', ensureButton);
  ensureButton();
})();
