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
                clips: [], clipped: 0, translates: [] };
const audio = { plays: 0, seeks: [], spans: [], oscStarts: 0, gainEvents: 0,
                decodes: 0, decodedBytes: 0, levels: [], oscFreqs: [] };
let lastCtx = null, lastSource = null;
global.atob = (s) => Buffer.from(s, "base64").toString("binary");
// Every download the page triggers: filename, scheme, and byte size where the
// stub can tell (a Blob's size, or a data: URI's length).
const downloads = [];
// Cache of the deviations table's play cells, keyed on the report markup.
const playCells = { html: null, cells: [] };

/* Tracks the horizontal translate so text positions can be reported in screen
   coordinates. That's what lets a test check that the track labels live in the
   left gutter and that scrolled content is clipped out of it. */
function ctx2d() {
  const noop = function () {};
  let tx = 0;
  const stack = [];
  return {
    canvas: null,
    save: () => { stack.push(tx); },
    restore: () => { tx = stack.length ? stack.pop() : 0; },
    translate: (x) => { tx += x; calls.translates.push(x); },
    setTransform: () => { tx = 0; },              // resize() resets the matrix
    rect: (x, y, w, h) => { calls.clips.push([x + tx, y, w, h]); },
    clip: () => { calls.clipped++; },
    clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    arcTo: noop, closePath: noop, setLineDash: noop,
    fillRect: function () { calls.rects++; },
    strokeRect: function () { calls.rects++; },
    fill: function () { calls.fill++; },
    stroke: function () { calls.stroke++; },
    fillText: function (t, x, y) {
      calls.text.push(String(t));
      // Record the alignment too: a right-aligned label occupies the space to
      // the LEFT of its x, which matters for collision checking.
      // tx === 0 marks the un-translated passes: the left gutter and the
      // scrollbar. Content is always drawn translated.
      calls.textAt.push([String(t), Math.round(x + tx), Math.round(y),
                         this.textAlign, String(t).length * 6, tx === 0]);
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
          start: () => { audio.oscStarts++; },
          stop: () => {}
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
  return { size, type: (opts || {}).type || "" };
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
  // has no parser, so synthesize cells from the recorded markup. Cached on the
  // markup itself: app.js attaches listeners to whatever this returns, so a
  // later lookup of the same report must hand back the *same* objects or the
  // listeners would be invisible to a test.
  querySelectorAll: (sel) => {
    if (sel !== "td.play") return [];
    const html = byId("report").innerHTML;
    if (playCells.html === html) return playCells.cells;
    const cells = [];
    const re = /<td class='(?:bad )?play' data-side='(\w+)' data-i='(-?\d+)'/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const td = makeEl("play-cell");
      td.dataset = { side: m[1], i: m[2] };
      cells.push(td);
    }
    playCells.html = html;
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
        size: b ? b.size : String(a.href).length
      });
    };
    a.remove = () => {};
    return a;
  }
});
global.getComputedStyle = () => ({
  // Return a real color/font so the drawing code has something plausible.
  getPropertyValue: (n) => (n === "--mono" ? "monospace" : "#888888")
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

// Move every slider across its range, in every view.
["per-char", "absolute", "overlay"].forEach((view) => {
  byId("view").value = view;
  fire(byId("view"), "change");
  [["wpm", 13], ["wpm", 35], ["farns", 9], ["tol", 8], ["tol", 55],
   ["gain", 0], ["gain", 30], ["zoom", 6], ["zoom", 48]].forEach(([id, v]) => {
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
  fire(canvas, "wheel", { deltaX: 240, deltaY: 0, preventDefault: () => {} });
  fire(canvas, "wheel", { deltaX: 0, deltaY: -90, preventDefault: () => {} });
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
  fire(byId("play-you"), "click");
  await flush();
  endReset.labelWhilePlaying = byId("play-you").textContent;
  endReset.buffered = !!(lastSource && lastSource.buffer);
  // Advance the context clock past the buffer's duration and pump the loop.
  lastCtx._t += global.REVIEW.duration_sec + 1;
  for (let i = 0; i < 3 && rafCb; i++) { const cb = rafCb; rafCb = null; cb(); }
  endReset.labelAfterEnd = byId("play-you").textContent;

  // And again via the source node's own ended event, for a throttled tab.
  fire(byId("play-you"), "click");
  await flush();
  if (lastSource && lastSource.onended) lastSource.onended();
  endReset.labelAfterEndedEvent = byId("play-you").textContent;
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

// ---- downloads ----------------------------------------------------------- //
// One of each per view, so the PNG export exercises all three renderers. The
// target WAV renders through a promise, so this stretch has to be async — and
// the final report must wait for it, or the download would go unrecorded.
async function exerciseDownloads() {
  for (const view of ["per-char", "absolute", "overlay"]) {
    byId("view").value = view;
    fire(byId("view"), "change");
    for (const id of ["dl-you", "dl-tgt", "dl-png"]) {
      fire(byId(id), "click");
      // Let the offline render and its .then chain settle.
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
  }
}

/* Per-view render check. Fill count alone can't tell the renderers apart —
   all three paint both tracks — so it only proves something was drawn. The
   YOU/TGT gutter positions are the structural signal: the split views put them
   in separate rows, overlay stacks them as a colour key inside one band.
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
  .then(exerciseFollow)
  .then(exerciseDownloads)
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
  downloads: downloads,
  dlStatus: byId("dl-status").textContent,
  abTest: abTest,
  endReset: endReset,
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
    decodes: audio.decodes,             // the embedded WAV was decoded...
    decodedBytes: audio.decodedBytes,   // ...and it had real bytes in it
    // Distinct gain values set. The listening level is a playback control, so
    // moving the slider must show up here and nowhere in the payload.
    levels: [...new Set(audio.levels.map((v) => +v.toFixed(4)))].sort(
      (a, b) => a - b),
    maxLevel: audio.levels.length ? Math.max(...audio.levels) : 0
  },
  scoresHTML: byId("scores").innerHTML,
  scoresWithoutTarget: scoresWithoutTarget,
  reportHTML: byId("report").innerHTML,
  title: global.document.title
}));
}
