/* A minimal DOM/Web-Audio stub, just enough to boot the review page in node.
 *
 * This exists so tests/test_web_review.py can catch the failure mode that would
 * otherwise only show up as a blank page in a browser: app.js throwing during
 * boot, layout, or draw. It records every canvas call so a test can assert the
 * page actually painted something, and it deliberately does NOT emulate layout
 * — nothing here checks how the page *looks*, only that it runs.
 *
 * Usage: node dom_stub.js <page.html>   -> prints a JSON summary.
 */
"use strict";

const fs = require("fs");

const calls = { fill: 0, stroke: 0, text: [], textAt: [], rects: 0,
                clips: [], clipped: 0, translates: [],
                // Every fill(): color, opacity, and the path's x-extent. Lets a
                // test find a translucent wash (a highlight), say which track's
                // color it was painted in, and check where it starts and ends
                // relative to the marks inside it.
                fillStyles: [] };
const audio = { plays: 0, seeks: [], spans: [], oscStarts: 0, gainEvents: 0,
                decodes: 0, decodedBytes: 0, levels: [], oscFreqs: [] };
let lastCtx = null, lastSource = null;
global.atob = (s) => Buffer.from(s, "base64").toString("binary");
// Every download the page triggers: filename, scheme, and byte size where the
// stub can tell (a Blob's size, or a data: URI's length).
const downloads = [];
// Cache of the deviations table's play cells, keyed on which render produced
// them — `reportGen` counts assignments to the report's innerHTML, each of
// which throws away the previous cells the way a real DOM does.
const playCells = { gen: -1, cells: [] };
let reportGen = 0;

/* Tracks the horizontal translate so text positions can be reported in screen
   coordinates. That's what lets a test check that the track labels live in the
   left gutter and that scrolled content is clipped out of it. */
function ctx2d() {
  const noop = function () {};
  let tx = 0;
  const stack = [];
  const path = [];       // x coordinates of the path being built
  return {
    canvas: null,
    save: () => { stack.push(tx); },
    restore: () => { tx = stack.length ? stack.pop() : 0; },
    translate: (x) => { tx += x; calls.translates.push(x); },
    setTransform: () => { tx = 0; },              // resize() resets the matrix
    rect: (x, y, w, h) => { calls.clips.push([x + tx, y, w, h]); },
    clip: () => { calls.clipped++; },
    clearRect: noop, closePath: noop, setLineDash: noop,
    // Enough path tracking to recover a filled shape's x-extent. roundRect's
    // arcTo control points are the rect's corners, so the extremes of these
    // are its left and right edges.
    beginPath: () => { path.length = 0; },
    moveTo: (x) => { path.push(x + tx); },
    lineTo: (x) => { path.push(x + tx); },
    arcTo: (x1, y1, x2) => { path.push(x1 + tx, x2 + tx); },
    fillRect: function () { calls.rects++; },
    strokeRect: function () { calls.rects++; },
    fill: function () {
      calls.fill++;
      calls.fillStyles.push([this.fillStyle, this.globalAlpha,
                             path.length ? Math.round(Math.min(...path)) : null,
                             path.length ? Math.round(Math.max(...path))
                                         : null]);
    },
    stroke: function () { calls.stroke++; },
    fillText: function (t, x, y) {
      calls.text.push(String(t));
      // Record the alignment too: a right-aligned label occupies the space to
      // the LEFT of its x, which matters for collision checking.
      // tx === 0 marks the un-translated passes: the left gutter and the
      // scrollbar. Content is always drawn translated.
      calls.textAt.push([String(t), Math.round(x + tx), Math.round(y),
                         this.textAlign, String(t).length * 6, tx === 0,
                         this.fillStyle]);
    },
    measureText: function (t) { return { width: String(t).length * 6 }; },
    set font(v) {}, get font() { return ""; },
    fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1,
    textAlign: "", textBaseline: ""
  };
}

function makeEl(id) {
  const listeners = {};
  const el = {
    id,
    tagName: id === "expected" ? "INPUT" : "DIV",
    style: {},
    dataset: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    children: [],
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    max: 100,
    offsetWidth: 100,
    clientWidth: 900,
    clientHeight: 200,
    scrollLeft: 0,
    width: 900,
    height: 200,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 200 }),
    getContext: () => ctx2d(),
    // Transport buttons hold their play/stop glyph in a nested .ico span, so
    // swapping it can't resize the button.
    querySelector: (sel) => {
      if (sel !== ".ico") return null;
      if (!el._ico) el._ico = makeEl(`${id}-ico`);
      return el._ico;
    },
    dispatch: (t, ev) => (listeners[t] || []).forEach((f) => f(ev || {})),
    _listeners: listeners
  };
  return el;
}

const els = {};
function byId(id) {
  if (!els[id]) els[id] = makeEl(id);
  return els[id];
}

/* Give an existing object a real listener registry, so a test can dispatch to
   it. `window` and `document` both carry page-level handlers (drag tracking,
   keyboard) that need firing. */
function eventTarget(obj) {
  const listeners = {};
  obj.addEventListener = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
  obj.removeEventListener = () => {};
  obj.dispatch = (t, ev) => (listeners[t] || []).forEach((f) => f(ev || {}));
  return obj;
}

// In a browser `window === globalThis`, and the page relies on that: a script
// that assigns to `globalThis.X` is read back as `window.X`. Mirror the
// identity rather than making `window` a separate object.
global.window = globalThis;

Object.assign(globalThis, {
  devicePixelRatio: 2,
  innerWidth: 1200,
  matchMedia: () => ({ addEventListener: () => {}, matches: true }),
  // Offline rendering for the downloadable target WAV. Returns silence: the
  // point is that the page schedules and encodes without throwing, not that
  // the samples are right (test_js_ideal_timeline_* covers the schedule).
  OfflineAudioContext: function (channels, length, rate) {
    // The rendered length shows whether the target got its padding.
    audio.offlineSeconds = length / rate;
    return {
      length, sampleRate: rate,
      destination: {},
      createOscillator: () => ({
        type: "", frequency: { value: 0 },
        connect: function (n) { return n; },
        disconnect: () => {},
        start: () => { audio.oscStarts++; },
        stop: () => {}
      }),
      createGain: () => ({
        gain: {
          value: 0,
          setValueAtTime: () => { audio.gainEvents++; },
          linearRampToValueAtTime: () => { audio.gainEvents++; }
        },
        connect: function (n) { return n; },
        disconnect: () => {}
      }),
      startRendering: () => Promise.resolve({
        length, sampleRate: rate,
        getChannelData: () => new Float32Array(length)
      })
    };
  },
  AudioContext: function () {
    const c = {
      state: "running",
      _t: 0,
      get currentTime() { return c._t; },
      resume: () => {},
      destination: {},
      // "Your sending" plays from a decoded buffer, not an <audio> element,
      // so the listening gain can boost it and the duration is exact.
      decodeAudioData: (buf, ok) => {
        audio.decodes++;
        audio.decodedBytes = buf.byteLength;
        const b = { duration: global.REVIEW.duration_sec,
                    sampleRate: global.REVIEW.audio_rate || 8000, length: 1 };
        if (ok) { ok(b); return undefined; }
        return Promise.resolve(b);
      },
      createBufferSource: () => {
        const s = {
          buffer: null, onended: null,
          connect: function (n) { return n; },
          disconnect: () => {},
          start: (when, offset, dur) => {
            audio.plays++;
            audio.seeks.push(offset || 0);
            audio.spans.push(dur);
          },
          stop: () => {}
        };
        lastSource = s;
        return s;
      },
      createOscillator: () => {
        const o = {
          type: "", frequency: { value: 0 }, onended: null,
          connect: function (n) { return n; },
          disconnect: () => {},
          // Record when the tone is scheduled to run: the span shows whether
          // the target got its padding, or was cut off at the last element.
          start: (when) => { audio.oscStarts++; audio.oscOn = when || 0; },
          stop: (when) => { audio.oscSpan = (when || 0) - (audio.oscOn || 0); }
        };
        audio.oscFreqs.push(o.frequency);
        return o;
      },
      // Records every level set, so a test can see the listening gain applied.
      createGain: () => {
        const g = {
          gain: {
            _v: 0,
            get value() { return g.gain._v; },
            set value(v) { g.gain._v = v; audio.levels.push(v); },
            setValueAtTime: () => { audio.gainEvents++; },
            linearRampToValueAtTime: () => { audio.gainEvents++; }
          },
          connect: function (n) { return n; },
          disconnect: () => {}
        };
        return g;
      }
    };
    lastCtx = c;
    return c;
  }
});
// Blob URLs, so the page's object-URL downloads can be inspected by size.
const blobUrls = new Map();
let blobSeq = 0;
global.Blob = function (parts, opts) {
  const size = parts.reduce(
    (n, p) => n + (p.byteLength ?? p.size ?? String(p).length), 0);
  // Text parts are kept whole: the JSON report download is only worth testing
  // if the test can parse what came out, not just weigh it.
  const text = parts.every((p) => typeof p === "string")
    ? parts.join("") : null;
  return { size, type: (opts || {}).type || "", text };
};
global.URL = {
  createObjectURL: (b) => {
    const u = `blob:stub/${++blobSeq}`;
    blobUrls.set(u, b);
    return u;
  },
  revokeObjectURL: () => {}
};
// The page only uses setTimeout to revoke object URLs later; skipping that in
// a stub is harmless, and it keeps node from idling for the delay.
global.setTimeout = () => 0;

eventTarget(globalThis);
global.document = eventTarget({
  body: { appendChild: () => {}, removeChild: () => {} },
  getElementById: byId,
  // The report re-renders innerHTML and then wires up its play cells; the stub
  // has no parser, so synthesize cells from the recorded markup. Cached, since
  // app.js attaches listeners to whatever this returns and a second lookup of
  // the *same* rendered report must hand back the same objects or those
  // listeners would be invisible to a test — but keyed on the generation, not
  // on the markup: assigning innerHTML destroys the old nodes and their
  // listeners even when it writes identical text, and matching by text instead
  // let one dispatch reach a listener per render.
  querySelectorAll: (sel) => {
    if (sel !== "td.play") return [];
    const html = byId("report").innerHTML;
    if (playCells.gen === reportGen) return playCells.cells;
    const cells = [];
    // Row-wise, so each cell also carries the timestamp its row names — that's
    // what lets a test check the played window actually contains that moment.
    // The class cell carries a title explaining the class, so allow attributes
    // on it and any label text — only the row's timestamp and its cells matter.
    const rowRe = /<tr><td>(-?[\d.]+)s<\/td><td[^>]*>[^<]*<\/td>(.*?)<\/tr>/g;
    const cellRe =
      /<td class='(?:bad )?play' data-side='(\w+)' data-i='(-?\d+)' data-kind='([\w-]+)'/g;
    let row;
    while ((row = rowRe.exec(html)) !== null) {
      let m;
      cellRe.lastIndex = 0;
      while ((m = cellRe.exec(row[2])) !== null) {
        const td = makeEl("play-cell");
        td.dataset = { side: m[1], i: m[2], kind: m[3], t: row[1] };
        cells.push(td);
      }
    }
    playCells.gen = reportGen;
    playCells.cells = cells;
    return cells;
  },
  title: "",
  // <a download> for saves, and an offscreen <canvas> for the PNG export.
  createElement: (tag) => {
    if (tag === "canvas") {
      const c = makeEl("offscreen-canvas");
      c.getContext = () => ctx2d();
      c.toBlob = (cb, type) => cb(new global.Blob(
        [{ byteLength: c.width * c.height }], { type }));
      c.toDataURL = () => "data:image/png;base64,stub";
      return c;
    }
    const a = makeEl("anchor");
    a.click = () => {
      const b = blobUrls.get(a.href);
      downloads.push({
        name: a.download,
        scheme: String(a.href).split(":")[0],
        size: b ? b.size : String(a.href).length,
        text: b && b.text ? b.text : null
      });
    };
    a.remove = () => {};
    return a;
  }
});
// Distinct color per custom property, so a test can tell *which* palette entry
// a given fill used — the real stylesheet isn't parsed here.
const STUB_COLORS = {
  "--ink": "#111111", "--ink-dim": "#222222", "--ink-faint": "#333333",
  "--line": "#444444", "--panel": "#555555", "--panel-2": "#666666",
  "--you": "#0000ff", "--tgt": "#00ff00", "--ok": "#00aa00",
  "--warn": "#aaaa00", "--bad": "#ff0000", "--ghost": "#777777",
  "--rest": "#ff00ff"
};
global.getComputedStyle = () => ({
  getPropertyValue: (n) =>
    n === "--mono" ? "monospace" : (STUB_COLORS[n] || "#888888")
});
let lastAudio = null;      // so a test can advance playback time by hand
global.Audio = function () {
  const a = eventTarget({
    src: "", preload: "", _t: 0, ended: false, duration: NaN,
    get currentTime() { return a._t; },
    set currentTime(v) { a._t = v; audio.seeks.push(v); },
    play: () => { audio.plays++; return Promise.resolve(); },
    pause: () => {}
  });
  lastAudio = a;
  return a;
};

// Hold the frame callback rather than dropping it, so the animation loop can
// be pumped deliberately.
let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
global.cancelAnimationFrame = () => { rafCb = null; };

// ---- load the page's inline scripts, in document order -------------------- //
const html = fs.readFileSync(process.argv[2], "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]);
if (scripts.length !== 4) {
  throw new Error(`expected 4 inline scripts, found ${scripts.length}`);
}
/* Range inputs keep their limits in the page markup, and app.js reads them back
   — the wheel zoom clamps to the zoom slider's own min/max. There's no HTML
   parser here, so lift those attributes across rather than letting every slider
   claim a made-up range, and give the ones that have a step a real setter:
   a browser sanitizes an assigned value by clamping and snapping it, which is
   why the slider can't hold the fractional zooms the wheel produces. Must run
   before the scripts, which read all of this at boot. */
[...html.matchAll(/<input\b[^>]*>/g)].forEach(([tag]) => {
  const id = /\bid="([\w-]+)"/.exec(tag);
  if (!id) return;
  const el = byId(id[1]);
  const attrs = {};
  for (const name of ["min", "max", "step"]) {
    const got = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
    if (got) el[name] = attrs[name] = got[1];
  }
  if (attrs.step === undefined) return;
  let held = el.value;
  Object.defineProperty(el, "value", {
    get: () => held,
    set: (v) => {
      const n = parseFloat(v);
      if (!isFinite(n)) { held = String(v); return; }
      const lo = parseFloat(el.min), hi = parseFloat(el.max);
      const step = parseFloat(el.step) || 1;
      let x = n;
      if (isFinite(lo)) x = Math.max(lo, x);
      if (isFinite(hi)) x = Math.min(hi, x);
      if (isFinite(lo)) x = lo + Math.round((x - lo) / step) * step;
      held = String(Math.round(x * 1e6) / 1e6);
    }
  });
});

/* Writing innerHTML replaces the element's children, so anything the stub
   synthesized from the old markup — and every listener app.js hung on it — is
   gone. Count the writes so the play-cell cache can tell one render from the
   next even when both produce the same text. */
(function () {
  const el = byId("report");
  let held = el.innerHTML;
  Object.defineProperty(el, "innerHTML", {
    get: () => held,
    set: (v) => { held = String(v); reportGen++; }
  });
})();

/* Every value each readout has ever shown. A reading that changes width drags
   the control row sideways with it, so what matters is that one output's
   strings are all the same length. Collected by watching the property rather
   than sampling at call sites, so nothing the page does can slip past. */
const readouts = {};
["wpm-out", "farns-out", "tol-out", "gain-out", "zoom-out"].forEach((id) => {
  const el = byId(id);
  const seen = (readouts[id] = []);
  let held = el.textContent;
  Object.defineProperty(el, "textContent", {
    get: () => held,
    set: (v) => { held = String(v); seen.push(held); }
  });
});

scripts.forEach((src, i) => {
  try {
    // Indirect eval so each runs in global scope, like a real <script>.
    (0, eval)(src);
  } catch (e) {
    throw new Error(`script ${i} threw: ${e.stack}`);
  }
});

// ---- exercise the interactive paths --------------------------------------- //
const canvas = byId("canvas");
const actions = [];
function fire(el, type, ev) {
  const name = el === globalThis ? "window"
             : el === global.document ? "document" : el.id;
  try {
    el.dispatch(type, ev);
    actions.push(`${name}:${type}`);
  } catch (e) {
    throw new Error(`${name} ${type} threw: ${e.stack}`);
  }
}

// Boot state, before anything is touched.
const initial = {
  gainOut: byId("gain-out").textContent,
  clock: byId("clock").textContent,
  // Where the zoom slider sits before anything is touched. The range it allows
  // lives in the page's own markup, which this stub doesn't parse — the test
  // reads that from the HTML and compares.
  zoom: byId("zoom").value,
  zoomOut: byId("zoom-out").textContent
};

/* Did the page open filling the track? `room` is how much scroll the chart has
   at the zoom it chose — zero means the content fits the width — and
   `oneStepIn` is the same one whole px/unit further in, which must be positive
   or the fit stopped short of the width it could have used. Probed here, before
   the sweeps below start moving things. */
function scrollRoom() {
  // Content is translated by (gutter - scrollX). Home pins scrollX at 0 and
  // End at maxScroll, so the difference is the scrollable width — measured
  // rather than derived, since the gutter is app.js's own constant.
  const at = (key) => {
    calls.translates.length = 0;
    fire(document, "keydown",
         { key, code: key, target: {}, preventDefault: () => {} });
    return calls.translates.length ? calls.translates[0] : null;
  };
  const top = at("Home"), end = at("End");
  return top === null || end === null ? null : Math.round(top - end);
}

const fitOpen = { zoom: byId("zoom-out").textContent, room: scrollRoom() };
byId("zoom").value = String(parseFloat(byId("zoom-out").textContent) + 1);
fire(byId("zoom"), "input");
fitOpen.oneStepIn = { zoom: byId("zoom-out").textContent,
                      room: scrollRoom() };
// Zoom right in, then click Fit: it must land back on the opening zoom and
// fill the width again. That's the button's whole job — it's a zoom you can't
// dial up, since it depends on the session and on the window's width.
byId("zoom").value = byId("zoom").max;
fire(byId("zoom"), "input");
fitOpen.zoomedIn = { zoom: byId("zoom-out").textContent, room: scrollRoom() };
fire(byId("zoom-fit"), "click");
fitOpen.refit = { zoom: byId("zoom-out").textContent, room: scrollRoom() };

// Move every slider across its range, in every view.
["per-char", "absolute", "overlay"].forEach((view) => {
  byId("view").value = view;
  fire(byId("view"), "change");
  [["wpm", 13], ["wpm", 35], ["farns", 9], ["tol", 8], ["tol", 55],
   ["gain", 0], ["gain", 30], ["zoom", 6], ["zoom", 48],
   // Both extremes of every slider as well, so the readout-width check sees
   // the widest and the narrowest reading each one can show — a signed
   // two-digit boost, a one-digit speed. Ordered to leave the speeds back at
   // the payload's, and wpm raised before farns follows it up (overall speed
   // can't exceed character speed, so the first drags the second down).
   ["wpm", 45], ["farns", 45], ["wpm", 5], ["tol", 5], ["tol", 60],
   ["gain", -6], ["gain", 42], ["gain", 0],
   ["wpm", 20], ["farns", 20]].forEach(([id, v]) => {
    byId(id).value = String(v);
    fire(byId(id), "input");
  });
  // Hover and click across the canvas at every band height: the gutter, the
  // ruler seek strip, both tracks, the drift strip, and the scrollbar.
  [8, 30, 55, 78, 100, 150, 175].forEach((y) => {
    for (let x = 0; x < 900; x += 37) {
      fire(canvas, "mousemove", { clientX: x, clientY: y });
      fire(canvas, "click", { clientX: x, clientY: y });
    }
  });
  fire(canvas, "mouseleave");

  // Internal scrolling: wheel, keyboard paging, drag-to-pan, and dragging the
  // scrollbar thumb (which must not also register as a character click).
  // A horizontal wheel pans; shift+wheel pans on deltaY; a plain vertical
  // wheel zooms (measured on its own further down).
  fire(canvas, "wheel", { deltaX: 240, deltaY: 0, clientX: 400, clientY: 100,
                          preventDefault: () => {} });
  fire(canvas, "wheel", { deltaX: 0, deltaY: 120, shiftKey: true,
                          clientX: 400, clientY: 100,
                          preventDefault: () => {} });
  fire(canvas, "wheel", { deltaX: 0, deltaY: -90, clientX: 400, clientY: 100,
                          preventDefault: () => {} });
  ["ArrowRight", "ArrowLeft", "End", "Home"].forEach((key) =>
    fire(document, "keydown", { key, code: key, target: {},
                                preventDefault: () => {} }));
  [["pan", 300, 100], ["thumb", 200, 176]].forEach(([, x0, y]) => {
    fire(canvas, "mousedown", { clientX: x0, clientY: y,
                                preventDefault: () => {} });
    fire(window, "mousemove", { clientX: x0 + 120, clientY: y });
    fire(window, "mouseup", {});
    fire(canvas, "click", { clientX: x0 + 120, clientY: y });
  });
});

// Transport, keyboard, and a rewritten intended message.
fire(byId("play-you"), "click");
fire(byId("play-you"), "click");
fire(byId("play-tgt"), "click");
fire(byId("play-tgt"), "click");
fire(byId("stop"), "click");
// Rewrite the intended message, including the degenerate empty case, then put
// it back so the reported end state is a normal one.
const originalExpected = byId("expected").value;
byId("expected").value = "CQ DE W7YFR K";
fire(byId("expected"), "input");
byId("expected").value = "";
fire(byId("expected"), "input");
const scoresWithoutTarget = byId("scores").innerHTML;
byId("expected").value = originalExpected;
fire(byId("expected"), "input");

// Playback is async now (the buffer is decoded on first play), so the rest of
// the checks live in promise chains.
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// ---- the deviations table's A/B play cells ------------------------------- //
// Clicking "yours" must drive the decoded buffer; clicking "target" must drive
// the oscillator. Track which of the two each click moves.
const abTest = { youClicks: 0, tgtClicks: 0 };
async function exerciseAB() {
  // Drain the click sweep's pending play promises first, or their resolutions
  // land inside this measurement.
  await flush();
  fire(byId("stop"), "click");
  const cells = global.document.querySelectorAll("td.play");
  const you = cells.filter((c) => c.dataset.side === "you");
  const tgt = cells.filter((c) => c.dataset.side === "tgt");
  abTest.cells = cells.length;
  const p0 = audio.plays;
  if (you.length) { fire(you[0], "click"); await flush(); }
  abTest.youClicks = audio.plays - p0;
  abTest.youSpan = audio.spans[audio.spans.length - 1];
  fire(byId("stop"), "click");
  const o0 = audio.oscStarts;
  if (tgt.length) { fire(tgt[0], "click"); await flush(); }
  abTest.tgtClicks = audio.oscStarts - o0;
  fire(byId("stop"), "click");
}

// ---- does playback reset the transport when it ends? --------------------- //
// The original bug: duration_sec is rounded, so the clock could plateau just
// under it and the `>=` test never fired, leaving the button stuck. Now the
// decoded buffer's real duration bounds it, plus the node's ended event.
const endReset = {};
async function exerciseEndReset() {
  const icon = () => byId("play-you").querySelector(".ico").textContent;
  fire(byId("play-you"), "click");
  await flush();
  endReset.labelWhilePlaying = icon();
  endReset.buffered = !!(lastSource && lastSource.buffer);
  // The clock is scheduled slightly ahead, so an unclamped reading would show
  // "-0.0s" for the first few frames.
  endReset.clocksWhilePlaying = [];
  for (let i = 0; i < 3 && rafCb; i++) {
    const cb = rafCb; rafCb = null; cb();
    endReset.clocksWhilePlaying.push(byId("clock").textContent);
  }
  // Advance the context clock past the buffer's duration and pump the loop.
  lastCtx._t += global.REVIEW.duration_sec + 1;
  for (let i = 0; i < 3 && rafCb; i++) { const cb = rafCb; rafCb = null; cb(); }
  endReset.labelAfterEnd = icon();

  // And again via the source node's own ended event, for a throttled tab.
  fire(byId("play-you"), "click");
  await flush();
  if (lastSource && lastSource.onended) lastSource.onended();
  endReset.labelAfterEndedEvent = icon();
  fire(byId("stop"), "click");
}

// ---- full target playback keeps its padding ------------------------------ //
// The download had the padding but live playback didn't, so the tone stopped
// the instant the last element ended. Restore the payload's speeds first so
// the expected length is computable from the payload alone.
const targetPlay = {};
async function exerciseTargetPlay() {
  fire(byId("stop"), "click");
  await flush();
  for (const [id, v] of [["wpm", global.REVIEW.target.char_wpm],
                         ["farns", global.REVIEW.target.farnsworth_wpm]]) {
    byId(id).value = String(v);
    fire(byId(id), "input");
  }
  audio.oscSpan = 0;
  fire(byId("play-tgt"), "click");
  await flush();
  targetPlay.span = audio.oscSpan || 0;
  fire(byId("stop"), "click");
}

// ---- does the view follow the playhead? ---------------------------------- //
// Put the controls back to a state where the content is wider than the view,
// start playback, then pump the frame loop with advancing audio time. Content
// is translated by (gutter - scrollX), so a falling translate means the view
// scrolled to keep up.
const follow = [];
async function exerciseFollow() {
  byId("view").value = "per-char";
  fire(byId("view"), "change");
  for (const [id, v] of [["zoom", 14], ["wpm", 20]]) {
    byId(id).value = String(v);
    fire(byId(id), "input");
  }
  fire(byId("play-you"), "click");
  await flush();
  const base = lastCtx._t;
  for (let i = 0; i < 60 && rafCb; i++) {
    lastCtx._t = base + i * 0.25;
    calls.translates.length = 0;
    const cb = rafCb;
    rafCb = null;
    cb();
    if (calls.translates.length) follow.push(Math.round(calls.translates[0]));
  }
  fire(byId("stop"), "click");
}

/* ---- hovering a deviation row highlights it on the canvas ---------------- //
   The highlight is a translucent wash in the hovered track's own color, so a
   test can find it by opacity and say which row lit up. Recorded per action:
   the fills painted by the redraw that hover/leave triggered. */
const devHover = {};
function exerciseDeviationHover() {
  byId("view").value = "per-char";
  fire(byId("view"), "change");
  const cells = global.document.querySelectorAll("td.play");
  const you = cells.find((c) => c.dataset.side === "you");
  const tgt = cells.find((c) => c.dataset.side === "tgt");
  if (!you || !tgt) return;
  // A wash is any fill painted at low opacity; report its color with it.
  const washes = (from) => calls.fillStyles.slice(from)
    .filter(([, a]) => a > 0 && a < 0.3).map(([c]) => c);

  /* Where the highlight starts, against where the marks inside it start.
     The highlight must open at the leading character's first mark — the gap
     *before* that character belongs to the character before it, and including
     it made a letter-gap highlight read as gap-char-gap-char. Marks are the
     only opaque fills in the band, so the leftmost one inside the wash is that
     first mark. */
  const leadIn = (from) => {
    const painted = calls.fillStyles.slice(from);
    const wash = painted.find(([, a]) => a > 0 && a < 0.3);
    if (!wash) return null;
    const [, , wx0, wx1] = wash;
    const marks = painted.filter(([, a, x0, x1]) =>
      a >= 0.9 && x0 !== null && x0 >= wx0 - 1 && x1 <= wx1 + 1);
    if (!marks.length) return null;
    return Math.min(...marks.map((m) => m[2])) - wx0;
  };

  let n = calls.fillStyles.length;
  fire(you, "mouseenter");
  devHover.you = washes(n);
  devHover.youLeadIn = leadIn(n);
  n = calls.fillStyles.length;
  fire(you, "mouseleave");
  devHover.afterLeave = washes(n);
  n = calls.fillStyles.length;
  fire(tgt, "mouseenter");
  devHover.tgt = washes(n);
  fire(tgt, "mouseleave");
  devHover.colors = { you: STUB_COLORS["--you"], tgt: STUB_COLORS["--tgt"] };

  /* Zoomed in far enough that the session overflows the view, hovering a row
     for a deviation the view has scrolled past has to bring it on screen —
     otherwise the highlight lands outside the viewport and the row appears to
     do nothing. Content is translated by (gutter - scrollX), so the translate
     stands in for the scroll position. The table is sorted by severity, not by
     time, so these two rows are just "different moments", not first and last. */
  byId("zoom").value = "60";
  fire(byId("zoom"), "input");
  const youCells = cells.filter((c) => c.dataset.side === "you");
  const other = youCells[youCells.length - 1];
  const translate = () => calls.translates[calls.translates.length - 1];
  calls.translates.length = 0;
  fire(you, "mouseenter");
  fire(you, "mouseleave");
  devHover.translateRowA = Math.round(translate());
  fire(other, "mouseenter");
  devHover.translateRowB = Math.round(translate());
  // Coming back to the same row lands the view in the same place.
  fire(other, "mouseleave");
  fire(other, "mouseenter");
  devHover.translateReHover = Math.round(translate());
  fire(other, "mouseleave");
  devHover.rows = youCells.length;
}

/* ---- what a deviation row plays ----------------------------------------- //
   Scope is per class: a letter gap gets the characters either side, a word gap
   the words either side. Recorded per row as [kind, the moment the row names,
   window start, window length] — enough to check the window contains that
   moment (the off-by-one that scoped every gap a character early) and that a
   word gap reaches wider than a letter gap. */
const devPlay = [];
async function exerciseDeviationPlay() {
  fire(byId("stop"), "click");
  const cells = global.document.querySelectorAll("td.play");
  // Cells come in (yours, target) pairs, one pair per row.
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const you = cells[i], tgt = cells[i + 1];
    if (you.dataset.side !== "you" || tgt.dataset.side !== "tgt") continue;
    const n = audio.spans.length;
    fire(you, "click");
    await flush();
    if (audio.spans.length === n) { fire(byId("stop"), "click"); continue; }
    const start = audio.seeks[audio.seeks.length - 1];
    const dur = audio.spans[audio.spans.length - 1];
    fire(byId("stop"), "click");
    // The target side is scoped the same way, so record its span too — it is
    // the ideal keying's own timeline, hence a different absolute length.
    audio.oscSpan = 0;
    fire(tgt, "click");
    await flush();
    devPlay.push([you.dataset.kind, Number(you.dataset.t), start, dur,
                  audio.oscSpan || 0]);
    fire(byId("stop"), "click");
  }
}

/* ---- the "collapse rests" toggle ---------------------------------------- //
   Collapsed, a rest keeps out of the grading and takes a fixed sliver of the
   chart; off, every silence is spacing, graded and drawn to scale. Recorded
   per setting: the chart's width (the scrollbar thumb's share of the track
   stands in for it), the gap labels drawn, and the deviation rows. */
const restToggle = {};
function measureRests(key) {
  byId("view").value = "per-char";
  fire(byId("view"), "change");
  const zoom = (v) => { byId("zoom").value = String(v);
                        fire(byId("zoom"), "input"); };
  const home = () => fire(document, "keydown",
    { key: "Home", code: "Home", target: {}, preventDefault: () => {} });

  // Zoomed right out the whole chart fits the viewport, so every gap label is
  // drawn — including the one over the rest, wherever it falls. Re-zooming to
  // the same value is no longer how you ask for a redraw (setZoom skips a
  // no-op); a scroll to the top always repaints, even from the top.
  zoom(4);
  calls.textAt.length = 0;
  home();
  const restLabels = calls.textAt.filter(([t]) => /^Rest /.test(t));
  const labels = [...new Set(restLabels.map((r) => r[0]))];
  // A rest is not graded, so it must not be drawn in the graded palette.
  const labelColors = [...new Set(restLabels.map((r) => r[6]))];

  // At a readable zoom, scrolling to the far end pins the view at maxScroll,
  // and content is translated by (gutter - scrollX) — so this reads out how
  // much wider than the viewport the chart is, which is what collapsing does.
  zoom(14);
  home();
  calls.translates.length = 0;
  fire(document, "keydown",
       { key: "End", code: "End", target: {}, preventDefault: () => {} });

  const html = byId("report").innerHTML;
  const re = /data-kind='([\w-]+)' title='hear yours'>([\d.]+)u/g;
  const devs = [];
  let m;
  while ((m = re.exec(html)) !== null) devs.push([m[1], Number(m[2])]);
  restToggle[key] = {
    overflow: Math.round(-calls.translates[calls.translates.length - 1]),
    restLabels: labels,
    restColors: labelColors,
    devs: devs,
    worst: devs.length ? Math.max(...devs.map((d) => d[1])) : 0
  };
  restToggle.colors = STUB_COLORS;
}
function exerciseRestToggle() {
  measureRests("collapsed");
  byId("rests").checked = false;
  fire(byId("rests"), "change");
  measureRests("expanded");
  byId("rests").checked = true;
  fire(byId("rests"), "change");
}

/* ---- the wheel zooms ---------------------------------------------------- //
   Each gesture is recorded as the zoom it left behind plus the content
   translate, which is (gutter - scrollX) — so a test can check the direction,
   that the slider follows, that the slider's own limits hold, and the one
   property that makes pointer-anchored zoom worth the trouble: the same
   gesture at the left and right edges of an identical view must not leave the
   view in the same place. */
const wheelZoom = { steps: [], anchored: {} };

// The readout is the honest source for the zoom: the slider snaps to whole
// numbers, so it can't report the fractions the wheel lands on.
const zoomState = () => ({ ppu: parseFloat(byId("zoom-out").textContent),
                           slider: Number(byId("zoom").value) });

function wheelAt(x, deltaY, shiftKey) {
  calls.translates.length = 0;
  fire(canvas, "wheel", { deltaX: 0, deltaY: deltaY, shiftKey: !!shiftKey,
                          clientX: x, clientY: 100,
                          preventDefault: () => {} });
  const s = zoomState();
  // null when the gesture drew nothing, which is itself worth seeing.
  s.translate = calls.translates.length
    ? Math.round(calls.translates[0]) : null;
  return s;
}

function exerciseWheelZoom() {
  byId("view").value = "per-char";
  fire(byId("view"), "change");
  const setSlider = (v) => {
    byId("zoom").value = String(v);
    fire(byId("zoom"), "input");
  };
  const home = () => fire(document, "keydown",
                          { key: "Home", code: "Home", target: {},
                            preventDefault: () => {} });

  setSlider(14);
  wheelZoom.steps.push(["start", zoomState()]);
  wheelZoom.steps.push(["in", wheelAt(400, -120)]);
  wheelZoom.steps.push(["in-again", wheelAt(400, -120)]);
  wheelZoom.steps.push(["out", wheelAt(400, 120)]);
  wheelZoom.steps.push(["out-again", wheelAt(400, 120)]);
  // A shift+wheel is a pan, so it must leave the zoom alone entirely.
  wheelZoom.steps.push(["shift", wheelAt(400, 240, true)]);
  // Far past either end: it stops at the slider's limits rather than running on.
  for (let i = 0; i < 40; i++) wheelAt(400, -240);
  wheelZoom.steps.push(["pinned-in", zoomState()]);
  for (let i = 0; i < 60; i++) wheelAt(400, 240);
  wheelZoom.steps.push(["pinned-out", zoomState()]);

  // Identical starting view, one gesture, two pointer positions.
  for (const [side, x] of [["left", 60], ["right", 860]]) {
    setSlider(10);
    home();
    wheelZoom.anchored[side] = wheelAt(x, -240);
  }
  setSlider(14);
}

// ---- downloads ----------------------------------------------------------- //
// One of each per view, so the PNG export exercises all three renderers. The
// target WAV renders through a promise, so this stretch has to be async — and
// the final report must wait for it, or the download would go unrecorded.
async function exerciseDownloads() {
  for (const view of ["per-char", "absolute", "overlay"]) {
    byId("view").value = view;
    fire(byId("view"), "change");
    for (const id of ["dl-you", "dl-tgt", "dl-png", "dl-json"]) {
      fire(byId(id), "click");
      // Let the offline render and its .then chain settle.
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
  }
}

/* The JSON report download, twice: once as the page opened, once after moving
   the controls that feed the grading. Two dumps of one recording are the only
   way to show the file reports what's on screen rather than a snapshot baked
   in at build time. Everything touched is put back, since later stretches
   assert against the report table and the scores. */
const jsonReports = {};

function grabJson(key) {
  const before = downloads.length;
  fire(byId("dl-json"), "click");
  const got = downloads.slice(before).filter((d) => d.text);
  jsonReports[key] = got.length ? JSON.parse(got[got.length - 1].text) : null;
  jsonReports[key + "Name"] = got.length ? got[got.length - 1].name : null;
}

function exerciseJsonReport() {
  const was = { wpm: byId("wpm").value, farns: byId("farns").value,
                tol: byId("tol").value, exp: byId("expected").value,
                rests: byId("rests").checked, view: byId("view").value };
  byId("view").value = "per-char";
  fire(byId("view"), "change");
  // Put the controls back where the page opened them — earlier stretches have
  // been dragging them around — so the first dump really is the payload's own
  // grading and can be compared against what the CLI would write.
  byId("wpm").value = String(global.REVIEW.target.char_wpm);
  fire(byId("wpm"), "input");
  byId("farns").value = String(global.REVIEW.target.farnsworth_wpm);
  fire(byId("farns"), "input");
  byId("tol").value = String(Math.round(global.REVIEW.tolerance * 100));
  fire(byId("tol"), "input");
  byId("expected").value = global.REVIEW.expected || global.REVIEW.decoded;
  fire(byId("expected"), "input");
  byId("rests").checked = true;
  fire(byId("rests"), "change");
  grabJson("asOpened");

  byId("wpm").value = "13";
  fire(byId("wpm"), "input");
  byId("tol").value = "10";
  fire(byId("tol"), "input");
  byId("expected").value = "SOS";
  fire(byId("expected"), "input");
  byId("rests").checked = false;
  fire(byId("rests"), "change");
  grabJson("regraded");

  byId("wpm").value = was.wpm;
  fire(byId("wpm"), "input");
  byId("farns").value = was.farns;
  fire(byId("farns"), "input");
  byId("tol").value = was.tol;
  fire(byId("tol"), "input");
  byId("expected").value = was.exp;
  fire(byId("expected"), "input");
  byId("rests").checked = was.rests;
  fire(byId("rests"), "change");
  byId("view").value = was.view;
  fire(byId("view"), "change");
}

/* Per-view render check. Fill count alone can't tell the renderers apart —
   all three paint both tracks — so it only proves something was drawn. The
   YOU/TGT gutter positions are the structural signal: the split views put them
   in separate rows, overlay stacks them as a color key inside one band.
   Reset the zoom first; the sweeps above left it far in. */
byId("zoom").value = "14";
fire(byId("zoom"), "input");
byId("wpm").value = "20";
fire(byId("wpm"), "input");
const viewFills = {}, viewRows = {};
["per-char", "absolute", "overlay"].forEach((view) => {
  byId("view").value = view;
  const before = calls.fill;
  calls.textAt.length = 0;
  fire(byId("view"), "change");
  viewFills[view] = calls.fill - before;
  const rows = {};
  for (const [t, , y, , , isGutter] of calls.textAt) {
    if (isGutter && (t === "YOU" || t === "TGT")) rows[t] = y;
  }
  viewRows[view] = rows;
});

// Sequenced: each stretch drives the page and leaves it stopped for the next.
exerciseAB()
  .then(exerciseEndReset)
  .then(exerciseTargetPlay)
  .then(exerciseFollow)
  .then(exerciseDeviationHover)
  .then(exerciseDeviationPlay)
  .then(exerciseRestToggle)
  .then(exerciseWheelZoom)
  .then(exerciseDownloads)
  .then(exerciseJsonReport)
  .then(report)
  .catch((e) => { console.error(e.stack || String(e)); process.exit(1); });

function report() {
// Snapshot exactly one frame's text, for the collision check below.
fire(byId("stop"), "click");
byId("zoom").value = "14";
fire(byId("zoom"), "input");
calls.textAt.length = 0;
byId("zoom").value = "20";
fire(byId("zoom"), "input");
const lastFrameStart = calls.textAt.length;
byId("zoom").value = "21";
fire(byId("zoom"), "input");
const lastFrame = calls.textAt.slice(lastFrameStart);

console.log(JSON.stringify({
  scripts: scripts.length,
  actions: actions.length,
  fills: calls.fill,
  strokes: calls.stroke,
  // Deduplicated, so a test can look for specific annotations without
  // drowning in one entry per redraw.
  labels: [...new Set(calls.text)].sort(),
  // Screen x of the leftmost draw of each distinct label, plus the clip rects
  // used — enough to tell gutter labels from clipped content.
  labelX: Object.fromEntries(
    calls.textAt.reduce((m, [t, x]) => m.set(t, Math.min(m.get(t) ?? 1e9, x)),
                        new Map())),
  clipLefts: [...new Set(calls.clips.map((c) => c[0]))].sort((a, b) => a - b),
  clipped: calls.clipped,
  // The gutter labels of ONE frame, as bounding boxes, so a test can check
  // none land on top of each other. Must be a single frame: the same slot
  // holds different text at different zoom levels, and comparing across
  // frames would flag those as collisions. Widths are the stub's crude
  // estimate — enough to catch two labels sharing a spot, not to validate
  // exact spacing.
  gutterLabels: (function () {
    const seen = new Set(), out = [];
    for (const [t, x, y, align, w, isGutter] of lastFrame) {
      if (!isGutter) continue;
      const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      const key = `${t}@${left},${y}`;
      if (seen.has(key)) continue;    // the same label redrawn is not a clash
      seen.add(key);
      out.push([t, left, y, w]);
    }
    return out;
  })(),
  // How far left content was translated: evidence that panning actually moved
  // the view (and that the labels above survived it).
  contentMinX: Math.min(...calls.textAt.map((t) => t[1])),
  // Content translate per frame while audio advanced; falls as the view
  // scrolls to keep the playhead visible.
  follow: follow,
  // Names and sizes only: the JSON report's own text is reported once, under
  // jsonReports, instead of a copy per download.
  downloads: downloads.map(
    ({ name, scheme, size }) => ({ name, scheme, size })),
  jsonReports: jsonReports,
  dlStatus: byId("dl-status").textContent,
  abTest: abTest,
  devHover: devHover,
  devPlay: devPlay,
  restToggle: restToggle,
  wheelZoom: wheelZoom,
  // Deduplicated: it's the set of distinct readings that has to be one width.
  readouts: Object.fromEntries(Object.entries(readouts).map(
    ([id, seen]) => [id, [...new Set(seen)]])),
  endReset: endReset,
  initial: initial,
  fitOpen: fitOpen,
  viewFills: viewFills,
  viewRows: viewRows,
  audio: {
    plays: audio.plays,
    seeked: audio.seeks.length,
    // A non-zero, non-trivial seek proves per-character playback ran rather
    // than everything restarting from the top.
    maxSeek: audio.seeks.length ? Math.max(...audio.seeks) : 0,
    oscStarts: audio.oscStarts,
    gainEvents: audio.gainEvents,
    offlineSeconds: audio.offlineSeconds || 0,
    // Scheduled length of a full live target playback.
    targetPlaySeconds: targetPlay.span || 0,
    decodes: audio.decodes,             // the embedded WAV was decoded...
    decodedBytes: audio.decodedBytes,   // ...and it had real bytes in it
    // Distinct gain values set. The listening level is a playback control, so
    // moving the slider must show up here and nowhere in the payload.
    levels: [...new Set(audio.levels.map((v) => +v.toFixed(4)))].sort(
      (a, b) => a - b),
    maxLevel: audio.levels.length ? Math.max(...audio.levels) : 0
  },
  // Every class name in the report with the hover text attached to it, so a
  // test can check each flagged class explains itself.
  classHelp: [...byId("report").innerHTML.matchAll(
    /<td class="why" title="([^"]*)">([^<]*)<\/td>/g)].map((m) => [m[2], m[1]]),
  scoresHTML: byId("scores").innerHTML,
  scoresWithoutTarget: scoresWithoutTarget,
  reportHTML: byId("report").innerHTML,
  title: global.document.title
}));
}
