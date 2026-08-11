// tests/format.test.js — node:test suite for the pure helpers in extension/lib/format.js.
// The extension loads the SAME file (as globalThis.YTDL_LIB), so these tests exercise the
// exact production logic — including the trim math that once caused a real bug (absolute
// -ss produced an empty file). Run with: node --test tests/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../extension/lib/format.js');

// ---- time -----------------------------------------------------------------

test('fmtTime formats h:mm:ss with zero padding', () => {
  assert.equal(L.fmtTime(0), '0:00:00');
  assert.equal(L.fmtTime(59), '0:00:59');
  assert.equal(L.fmtTime(60), '0:01:00');
  assert.equal(L.fmtTime(3599), '0:59:59');
  assert.equal(L.fmtTime(3661), '1:01:01');
  assert.equal(L.fmtTime(90061), '25:01:01');
  assert.equal(L.fmtTime(-5), '0:00:00');
});

test('parseTime parses 1-3 colon segments', () => {
  assert.equal(L.parseTime('0'), 0);
  assert.equal(L.parseTime('1:30'), 90);
  assert.equal(L.parseTime('1:02:03'), 3723);
  assert.equal(L.parseTime(' 2:00 '), 120);
});

test('parseTime rejects garbage', () => {
  assert.equal(L.parseTime('abc'), null);
  assert.equal(L.parseTime('1:xx'), null);
  // Empty/whitespace parses to 0 (Number('') = 0) — callers treat end <= 0 as
  // "whole video", so this is safe production behavior, documented here.
  assert.equal(L.parseTime(''), 0);
  assert.equal(L.parseTime('   '), 0);
  assert.equal(L.parseTime(':30'), 30); // leading colon is tolerated
});

test('time round-trip: parseTime(fmtTime(sec)) === sec', () => {
  for (const sec of [0, 1, 59, 60, 3599, 3661, 90061]) {
    assert.equal(L.parseTime(L.fmtTime(sec)), sec, 'round-trip for ' + sec);
  }
});

// ---- computeJob (trim / re-encode decision matrix) -------------------------

test('computeJob: full-video mp4, no transcode → plain stream copy', () => {
  const j = L.computeJob({ start: 0, end: 3600, duration: 3600, capturedFrom: 0, isMp3: false, transcode: false });
  assert.deepEqual(j, {
    trimStart: 0, trimDuration: 3600, isFragment: false, needsExactCut: false,
    shortEnough: false, exactCut: false, doTranscode: false, alignedStart: false, quickEncode: false,
  });
});

test('computeJob: short fragment → frame-accurate re-encode cut', () => {
  const j = L.computeJob({ start: 300, end: 360, duration: 3600, capturedFrom: 290, isMp3: false, transcode: false });
  assert.equal(j.trimStart, 10);      // RELATIVE to the captured file, not 300 (the old bug)
  assert.equal(j.trimDuration, 60);
  assert.equal(j.isFragment, true);
  assert.equal(j.needsExactCut, true);
  assert.equal(j.shortEnough, true);
  assert.equal(j.exactCut, true);
  assert.equal(j.doTranscode, true);
  assert.equal(j.alignedStart, false);
  assert.equal(j.quickEncode, true);
});

test('computeJob: long fragment → keyframe-aligned copy, no re-encode', () => {
  const j = L.computeJob({ start: 300, end: 600, duration: 3600, capturedFrom: 290, isMp3: false, transcode: false });
  assert.equal(j.trimStart, 10);
  assert.equal(j.trimDuration, 300);
  assert.equal(j.exactCut, false);
  assert.equal(j.doTranscode, false);
  assert.equal(j.alignedStart, true);
});

test('computeJob: user-selected H.264 wins over the copy path', () => {
  const j = L.computeJob({ start: 300, end: 600, duration: 3600, capturedFrom: 290, isMp3: false, transcode: true });
  assert.equal(j.doTranscode, true);
  assert.equal(j.alignedStart, false);
  assert.equal(j.quickEncode, false); // user transcode, not an automatic exact cut
});

test('computeJob: mp3 always transcodes and never takes the exact-cut path', () => {
  const j = L.computeJob({ start: 0, end: 3600, duration: 3600, capturedFrom: 0, isMp3: true, transcode: false });
  assert.equal(j.doTranscode, true);
  assert.equal(j.exactCut, false);
  assert.equal(j.alignedStart, false);
});

test('computeJob: trimStart inside keyframe tolerance (≤0.3s) needs no exact cut', () => {
  const j = L.computeJob({ start: 300, end: 360, duration: 3600, capturedFrom: 299.9, isMp3: false, transcode: false });
  assert.ok(Math.abs(j.trimStart - 0.1) < 1e-9, 'trimStart ≈ 0.1, got ' + j.trimStart);
  assert.equal(j.needsExactCut, false);
  assert.equal(j.exactCut, false);
  assert.equal(j.alignedStart, false);
});

test('computeJob: capturedFrom missing → trim from the requested start', () => {
  // content_ui falls back to `start` when the hook doesn't report capturedFrom.
  const j = L.computeJob({ start: 300, end: 360, duration: 3600, capturedFrom: 300, isMp3: false, transcode: false });
  assert.equal(j.trimStart, 0);
  assert.equal(j.needsExactCut, false);
});

// ---- base64 ---------------------------------------------------------------

test('b64 round-trip across the 0x8000 chunk boundary', () => {
  for (const size of [0, 1, 3, 0x7fff, 0x8000, 0x8001, 100000]) {
    const u8 = new Uint8Array(size);
    for (let i = 0; i < size; i++) u8[i] = (i * 31 + (i >> 8)) & 0xff; // deterministic pseudo-random
    const dec = L.b64decode(L.b64encode(u8));
    assert.equal(dec.length, size, 'length for size ' + size);
    assert.deepEqual(dec, u8, 'bytes for size ' + size);
  }
});

// ---- buildRuns (offscreen ffmpeg cascade) ---------------------------------

test('buildRuns: mp3 → single mp3 run', () => {
  const runs = L.buildRuns({ isMp3: true, transcode: false, quickEncode: false, trimStart: 0, trimDuration: 0, vName: null, aName: 'a.webm' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].name, 'mp3');
  assert.equal(runs[0].ext, '.mp3');
  assert.ok(runs[0].args.includes('-c:a'));
  assert.ok(runs[0].args.includes('libmp3lame'));
});

test('buildRuns: transcode → single h264 run; quickEncode picks ultrafast', () => {
  const plain = L.buildRuns({ isMp3: false, transcode: true, quickEncode: false, trimStart: 0, trimDuration: 0, vName: 'v.webm', aName: 'a.webm' });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].name, 'h264');
  assert.ok(plain[0].args.includes('veryfast'));
  const quick = L.buildRuns({ isMp3: false, transcode: true, quickEncode: true, trimStart: 0, trimDuration: 0, vName: 'v.webm', aName: 'a.webm' });
  assert.ok(quick[0].args.includes('ultrafast'));
});

test('buildRuns: copy cascade order + untrimmed fallback only when trimming', () => {
  const plain = L.buildRuns({ isMp3: false, transcode: false, quickEncode: false, trimStart: 0, trimDuration: 0, vName: 'v.mp4', aName: 'a.m4a' });
  assert.deepEqual(plain.map((r) => r.name), ['mp4-copy', 'webm-copy']);
  const trimmed = L.buildRuns({ isMp3: false, transcode: false, quickEncode: false, trimStart: 10, trimDuration: 60, vName: 'v.mp4', aName: 'a.m4a' });
  assert.deepEqual(trimmed.map((r) => r.name), ['mp4-copy', 'mp4-copy-untrimmed', 'webm-copy']);
  assert.equal(trimmed[trimmed.length - 1].name, 'webm-copy'); // last resort stays last
});

test('buildRuns: exact cut seeks (-ss) and limits (-t) with frame precision', () => {
  const runs = L.buildRuns({ isMp3: false, transcode: true, quickEncode: false, trimStart: 10.5, trimDuration: 60, vName: 'v.webm', aName: 'a.webm' });
  const args = runs[0].args;
  assert.ok(args.includes('-ss'));
  assert.ok(args.includes('10.500'));
  assert.ok(args.includes('-t'));
  assert.ok(args.includes('60.000'));
});

test('buildRuns: copy path never seeks; trims to trimStart+trimDuration', () => {
  const runs = L.buildRuns({ isMp3: false, transcode: false, quickEncode: false, trimStart: 10.5, trimDuration: 60, vName: 'v.webm', aName: 'a.webm' });
  const args = runs[0].args; // mp4-copy
  assert.ok(!args.includes('-ss'), 'copy must not seek');
  assert.ok(args.includes('-t'));
  assert.ok(args.includes('70.500'));
  assert.ok(args.includes('-avoid_negative_ts'));
});

test('buildRuns: no video input (mp3) → args never reference the video file', () => {
  const runs = L.buildRuns({ isMp3: true, transcode: false, quickEncode: false, trimStart: 0, trimDuration: 0, vName: null, aName: 'a.webm' });
  assert.ok(!runs[0].args.includes('v.'));
});

// ---- splitRange / extFor / concat / safeName / fragSuffix -----------------

test('splitRange splits into bounded parts and clamps the last one', () => {
  const parts = L.splitRange(0, 3600, 900);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts[0], { start: 0, end: 900 });
  assert.deepEqual(parts[3], { start: 2700, end: 3600 });
  assert.deepEqual(L.splitRange(0, 600, 900), [{ start: 0, end: 600 }]);
  const last = L.splitRange(100, 3700, 900);
  assert.equal(last.length, 4);
  assert.equal(last[last.length - 1].end, 3700);
});

test('extFor guesses the container from the MIME', () => {
  assert.equal(L.extFor('video/webm; codecs="vp9"'), 'webm');
  assert.equal(L.extFor('video/mp4'), 'mp4');
  assert.equal(L.extFor('audio/mpeg'), 'bin');
});

test('concat joins byte chunks in order', () => {
  const out = L.concat([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]);
  assert.deepEqual(out, new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(L.concat([]).length, 0);
});

test('safeName strips illegal filename characters and caps length', () => {
  assert.equal(L.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(L.safeName('  spaced   out  '), 'spaced out');
  assert.equal(L.safeName(''), 'video');
  assert.equal(L.safeName('x'.repeat(200)).length, 120);
});

test('fragSuffix only adds a suffix for real fragments', () => {
  assert.equal(L.fragSuffix(0, 3600, 3600), '');
  assert.equal(L.fragSuffix(0, 3599.6, 3600), ''); // within the 0.5s tolerance
  assert.equal(L.fragSuffix(60, 120, 3600), ' (0.01.00-0.02.00)');
  assert.equal(L.fragSuffix(0, 300, 3600), ' (0.00.00-0.05.00)');
});
