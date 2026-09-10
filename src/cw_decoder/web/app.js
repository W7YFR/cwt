/* app.js — the review canvas, transport, and report.
 *
 * All grading lives in review-core.js (a tested port of core.py); this file is
 * geometry, pixels, audio, and events. Nothing here is persisted: every control
 * just re-runs recompute() over the payload's raw segments, which is why the
 * page can re-grade at any speed without a server.
 *
 * The canvas is always exactly the container's width and scrolls itself. That
 * keeps a native scrollbar from clashing with the panel, lets the view follow
 * the playhead during playback, and gives the track labels a gutter the content
 * is clipped out of instead of sliding underneath them.
 */
(function () {
  "use strict";

  var RC = window.ReviewCore;
  var P = window.REVIEW;
  RC.setMorse(window.MORSE);

  // ---- geometry ---------------------------------------------------------- //
  var GUTTER = 44;       // left band for track labels; content never enters it
  var PAD_R = 10;        // right margin inside the plot
  var PAD_X = 8;         // leading margin in content coordinates
  var LABEL_H = 22;      // character captions
  var ROW_H = 34;        // one track (marks are drawn inside this)
  var GRADE_H = 14;      // the OK / ~ / ** marker strip between tracks
  var DRIFT_H = 46;      // cumulative timing drift
  var RULER_H = 18;
  var SCROLL_H = 14;     // the canvas-drawn scrollbar band
  var SLOT_GAP = 10;     // breathing room between per-character slots
  var MARK_H = 20;       // height of a dit/dah block

  var Y_RULER = 0;
  var Y_LABEL = RULER_H;
  var Y_YOU = RULER_H + LABEL_H;
  var Y_GRADE = Y_YOU + ROW_H;
  var Y_TGT = Y_GRADE + GRADE_H;
  var Y_DRIFT = Y_TGT + ROW_H + 6;
  var Y_SCROLL = Y_DRIFT + DRIFT_H + 2;
  var HEIGHT = Y_SCROLL + SCROLL_H;
  var PLOT_BOTTOM = Y_DRIFT + DRIFT_H;   // where scrollable content ends
  // Overlay mode superimposes the tracks, so it gets the whole band the two
  // separate rows and the grade strip would have used.
  var OVER_H = (Y_TGT + ROW_H) - Y_YOU;
  var OVER_MARK_H = OVER_H - 14;

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $("canvas");
  var ctx = canvas.getContext("2d");
  var plot = $("plot");
  var tip = $("tip");

  function css(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }
  var C = {};
  function readColors() {
    ["--ink", "--ink-dim", "--ink-faint", "--line", "--panel", "--panel-2",
     "--you", "--tgt", "--ok", "--warn", "--bad", "--ghost"].forEach(
      function (n) { C[n.slice(2)] = css(n); });
  }

  // ---- state ------------------------------------------------------------- //
  var S = {
    charWpm: P.target.char_wpm,
    farnsWpm: P.target.farnsworth_wpm,
    tolerance: P.tolerance,
    // The intended message. Defaults to the decode captured at build time when
    // none was supplied, so the target track means "what you sent, keyed
    // perfectly" and spacing grading still works.
    expected: P.expected || P.decoded,
    view: "per-char",
    ppu: 14,               // pixels per dit unit — the single zoom knob
    // Playback gain in dB, applied at playback only — never baked into the
    // samples or the download. Starts at unity: the recording plays back at
    // the level it was made, and boosting is an explicit choice. Applied
    // equally to the target track, so A/B compares timing not loudness.
    gainDb: 0,
    scrollX: 0,            // content px scrolled past the gutter
    hover: null,
    playhead: null         // {t: seconds, side: "you"|"tgt"}
  };

  var M = {};              // current model, rebuilt by recompute()
  var L = null;            // current layout, rebuilt by relayout()
  var driftMax = 1;        // drift axis bound, set while drawing
  // Set while rendering to an offscreen canvas (the PNG export), so draw()
  // sees a viewport as wide as the whole analysis instead of the window.
  var renderOverride = null;

  // ---- model ------------------------------------------------------------- //
  function recompute() {
    var timing = RC.targetTiming(S.charWpm, S.farnsWpm);
    var actual = RC.buildTimeline(P.segments, timing);
    var ideal = RC.idealTimeline(S.expected, timing);
    // Retarget from the pairing, so every panel below grades each gap as the
    // intended text says it should be rather than as its length read. With no
    // intended text the ideal is empty, nothing pairs, and every gap keeps the
    // class its duration implied.
    var slots = RC.pair(actual, ideal);
    RC.retarget(slots);
    M = {
      timing: timing,
      actual: actual,
      ideal: ideal,
      slots: slots,
      grade: RC.grade(actual, S.tolerance),
      compare: RC.compare(S.expected, actual.text)
    };
    relayout();
    renderScores();
    renderReport();
  }

  // Grade a measured/target unit pair the way cli._grade does, so the page and
  // the terminal report never disagree about what counts as clean.
  function gradeOf(units, target) {
    if (!(target > 0)) return "none";
    var rel = Math.abs(units - target) / target;
    if (rel <= S.tolerance) return "ok";
    return rel <= 2 * S.tolerance ? "warn" : "bad";
  }
  var GRADE_MARK = { ok: "OK", warn: "~", bad: "**", none: "" };

  // ---- viewport & scrolling ---------------------------------------------- //
  function viewport() {
    if (renderOverride) return renderOverride;
    var viewW = Math.max(plot.clientWidth, GUTTER + 40);
    var trackW = Math.max(viewW - GUTTER - PAD_R, 1);
    var contentW = L ? L.width : trackW;
    return { viewW: viewW, trackW: trackW, contentW: contentW,
             maxScroll: Math.max(0, contentW - trackW) };
  }

  function clampScroll(v) {
    S.scrollX = Math.min(Math.max(S.scrollX, 0), v.maxScroll);
  }

  function scrollTo(x) {
    var v = viewport();
    S.scrollX = x;
    clampScroll(v);
    draw();
  }

  /* Keep the playhead on screen while audio runs. Page-jump rather than
     continuous centering: predictable, and it doesn't slide the whole view on
     every frame. */
  function followPlayhead(contentX) {
    var v = viewport();
    if (!v.maxScroll) return;
    var lead = contentX - S.scrollX;
    if (lead > v.trackW * 0.8 || lead < 0) {
      S.scrollX = contentX - v.trackW * 0.2;
      clampScroll(v);
    }
  }

  // ---- layout ------------------------------------------------------------ //
  // Two modes, deliberately different:
  //  per-char : every character pair starts at the same x, so element shape is
  //             readable; accumulated drift is invisible here (see the drift
  //             strip below, which is where it shows up).
  //  absolute : one shared wall clock, so drift shears the tracks apart.
  function charWidth(ch) {
    if (!ch) return 0;
    var u = 0;
    ch.blocks.forEach(function (b) { u += b.units; });
    return u * S.ppu;
  }

  /* Recompute the layout without touching the canvas. Split out so the PNG
     export can lay out at a different zoom before drawing offscreen. */
  function relayoutOnly() {
    var ppu = S.ppu;
    var items = [];             // {x, w, slot, gapW, youGapW, tgtGapW}
    var maps = { you: [], tgt: [] };

    if (S.view === "per-char") {
      var x = PAD_X;
      M.slots.forEach(function (slot) {
        var yg = slot.actual && slot.actual.leadGap
               ? slot.actual.leadGap.units * ppu : 0;
        var tg = slot.ideal && slot.ideal.leadGap
               ? slot.ideal.leadGap.units * ppu : 0;
        var gapW = Math.max(yg, tg);
        var bodyW = Math.max(charWidth(slot.actual), charWidth(slot.ideal));
        items.push({ x: x, gapW: gapW, youGapW: yg, tgtGapW: tg,
                     bodyW: bodyW, w: gapW + bodyW, slot: slot });
        // Time->x breakpoints for the playhead, from the blocks as drawn.
        if (slot.actual) {
          var bx = x + gapW;
          if (slot.actual.leadGap) {
            maps.you.push([slot.actual.leadGap.t0, x]);
            maps.you.push([slot.actual.leadGap.t1, x + yg]);
          }
          slot.actual.blocks.forEach(function (b) {
            maps.you.push([b.t0, bx]);
            bx += b.units * ppu;
            maps.you.push([b.t1, bx]);
          });
        }
        if (slot.ideal) {
          var ix = x + gapW;
          if (slot.ideal.leadGap) {
            maps.tgt.push([slot.ideal.leadGap.t0, x]);
            maps.tgt.push([slot.ideal.leadGap.t1, x + tg]);
          }
          slot.ideal.blocks.forEach(function (b) {
            maps.tgt.push([b.t0, ix]);
            ix += b.units * ppu;
            maps.tgt.push([b.t1, ix]);
          });
        }
        x += gapW + bodyW + SLOT_GAP;
      });
      L = { items: items, width: x + PAD_X, maps: maps, origin: 0 };
    } else {
      // Absolute time (and overlay, which is the same axis with the two tracks
      // superimposed): pin the ideal's t=0 to the first keyed mark, so the
      // tracks share an origin and every later divergence is real drift.
      var origin = M.actual.chars.length ? M.actual.chars[0].t0 : 0;
      var u = M.timing.unitSec;
      var toX = function (t, base) { return PAD_X + (t - base) / u * ppu; };
      M.slots.forEach(function (slot) {
        items.push({ slot: slot,
                     x: slot.actual ? toX(slot.actual.t0, origin) : null,
                     ix: slot.ideal ? toX(slot.ideal.t0, 0) : null });
      });
      maps.you.push([origin, PAD_X]);
      maps.you.push([P.duration_sec, toX(P.duration_sec, origin)]);
      maps.tgt.push([0, PAD_X]);
      maps.tgt.push([M.ideal.duration, toX(M.ideal.duration, 0)]);
      var w = Math.max(toX(P.duration_sec, origin),
                       toX(M.ideal.duration, 0)) + PAD_X;
      L = { items: items, width: w, maps: maps, origin: origin, toX: toX };
    }
  }

  function relayout() {
    relayoutOnly();
    resize();
  }

  function timeToX(t, side) {
    var m = L.maps[side];
    if (!m.length) return PAD_X;
    if (t <= m[0][0]) return m[0][1];
    for (var i = 1; i < m.length; i++) {
      if (t <= m[i][0]) {
        var span = m[i][0] - m[i - 1][0];
        var f = span > 1e-12 ? (t - m[i - 1][0]) / span : 0;
        return m[i - 1][1] + f * (m[i][1] - m[i - 1][1]);
      }
    }
    return m[m.length - 1][1];
  }

  function xToTime(x, side) {
    var m = L.maps[side];
    if (!m.length) return 0;
    for (var i = 1; i < m.length; i++) {
      if (x <= m[i][1]) {
        var span = m[i][1] - m[i - 1][1];
        var f = span > 1e-12 ? (x - m[i - 1][1]) / span : 0;
        return m[i - 1][0] + f * (m[i][0] - m[i - 1][0]);
      }
    }
    return m[m.length - 1][0];
  }

  // Screen <-> content x. Content lives to the right of the gutter.
  function screenX(contentX) { return GUTTER + contentX - S.scrollX; }
  function contentX(sx) { return sx - GUTTER + S.scrollX; }

  // ---- drawing ----------------------------------------------------------- //
  function resize() {
    if (renderOverride) return;        // offscreen render sizes its own canvas
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(plot.clientWidth, 1);
    canvas.style.width = w + "px";
    canvas.style.height = HEIGHT + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fmtU(u) { return u.toFixed(u < 10 ? 1 : 0) + "u"; }

  function draw() {
    var v = viewport();
    clampScroll(v);
    ctx.clearRect(0, 0, v.viewW, HEIGHT);

    drawFrame(v);

    // Content is clipped to the right of the gutter, so scrolled blocks pass
    // behind the label band instead of over it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, v.viewW - GUTTER, PLOT_BOTTOM);
    ctx.clip();
    ctx.translate(GUTTER - S.scrollX, 0);
    ctx.font = "500 11px " + css("--mono");
    drawTicks(v);
    if (S.view === "per-char") drawPerChar(v);
    else if (S.view === "overlay") drawOverlay(v);
    else drawAbsolute(v);
    drawDrift(v);
    ctx.restore();

    drawGutter(v);
    drawScrollbar(v);
    drawPlayhead(v);
  }

  function visible(x, w, v) {
    return x + w >= S.scrollX - 40 && x <= S.scrollX + v.trackW + 40;
  }

  /* Structural rules, in screen coordinates so they span the visible track. */
  function drawFrame(v) {
    var right = v.viewW - PAD_R;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER, Y_RULER + RULER_H - 0.5);
    ctx.lineTo(right, Y_RULER + RULER_H - 0.5);
    ctx.moveTo(GUTTER, Y_DRIFT + DRIFT_H / 2 + 0.5);
    ctx.lineTo(right, Y_DRIFT + DRIFT_H / 2 + 0.5);
    ctx.stroke();
  }

  /* Second ticks. The per-character mapping is piecewise, so go through
     timeToX rather than assuming a linear axis. */
  function drawTicks(v) {
    ctx.fillStyle = C["ink-faint"];
    ctx.font = "10px " + css("--mono");
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    var last = -1e9;
    // Only label times the axis can actually place. Past the final keyed mark
    // the per-character map has no breakpoints left, so timeToX clamps — and
    // every remaining second would stack a wrong label on the right edge.
    var maxT = P.duration_sec;
    var mapYou = L.maps.you;
    if (S.view === "per-char" && mapYou.length) {
      maxT = mapYou[mapYou.length - 1][0];
    }
    for (var s = 0; s <= Math.floor(maxT); s++) {
      var x = timeToX(s, "you");
      if (!visible(x, 1, v)) continue;
      if (x - last < 34) continue;          // don't crowd the labels
      last = x;
      ctx.strokeStyle = C.line;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, Y_RULER + 4);
      ctx.lineTo(x + 0.5, Y_RULER + RULER_H);
      ctx.stroke();
      ctx.fillStyle = C["ink-faint"];
      ctx.fillText(s + "s", x + 4, Y_RULER + 8);
    }
  }

  /* One slot: the lead gap, then the character's marks, on both tracks. */
  function drawPerChar(v) {
    L.items.forEach(function (it) {
      if (!visible(it.x, it.w, v)) return;
      var slot = it.slot;

      // Caption: the decoded character, plus what it should have been.
      var cap = slot.actual ? slot.actual.char : "·";
      var capColor = C.ink;
      if (slot.op === "sub") {
        cap = slot.actual.char + "→" + slot.ideal.char;
        capColor = C.bad;
      } else if (slot.op === "del") {
        cap = "–" + slot.ideal.char; capColor = C.bad;
      } else if (slot.op === "ins") {
        cap = "+" + slot.actual.char; capColor = C.bad;
      }
      ctx.fillStyle = capColor;
      ctx.font = "600 12px " + css("--mono");
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(cap, it.x + it.gapW + it.bodyW / 2, Y_LABEL + LABEL_H / 2);

      // A word-boundary error is called out above the gap that caused it.
      if (slot.spaceOp === "del" || slot.spaceOp === "ins") {
        ctx.fillStyle = C.bad;
        ctx.font = "600 9px " + css("--mono");
        ctx.fillText(slot.spaceOp === "del" ? "no space" : "extra space",
                     it.x + it.gapW / 2, Y_LABEL + 5);
      }

      var bx = it.x + it.gapW;

      // Where the character starts. Both rows' gaps begin at the slot's left
      // edge, but the slot is as wide as the LONGER of the two, so the shorter
      // gap's bracket stops short of this line. Without the line that
      // shortfall reads as a rendering gap instead of the measurement it is.
      if (it.gapW > 0 && Math.abs(it.youGapW - it.tgtGapW) > 1.5) {
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bx - 0.5, Y_YOU + 2);
        ctx.lineTo(bx - 0.5, Y_TGT + ROW_H - 2);
        ctx.stroke();
      }

      drawGap(slot.actual && slot.actual.leadGap, it.x, it.youGapW, Y_YOU,
              false);
      drawGap(slot.ideal && slot.ideal.leadGap, it.x, it.tgtGapW, Y_TGT, true);
      // A side with no character gets an outlined ghost, so a missed or an
      // extra character reads as a hole rather than as a shifted neighbour.
      if (slot.actual) drawMarks(slot.actual, bx, Y_YOU, false);
      else drawGhost(bx, it.bodyW, Y_YOU);
      if (slot.ideal) drawMarks(slot.ideal, bx, Y_TGT, true);
      else drawGhost(bx, it.bodyW, Y_TGT);
      drawGradeStrip(slot, bx, it.bodyW);
    });
  }

  function drawAbsolute(v) {
    var u = M.timing.unitSec;
    var ppu = S.ppu;
    L.items.forEach(function (it) {
      var slot = it.slot;
      if (slot.actual && it.x !== null) {
        var w = (slot.actual.t1 - slot.actual.t0) / u * ppu;
        if (visible(it.x, w, v)) {
          var g = slot.actual.leadGap;
          if (g) drawGap(g, it.x - g.units * ppu, g.units * ppu, Y_YOU, false);
          drawMarks(slot.actual, it.x, Y_YOU, false);
          ctx.fillStyle = slot.op === "equal" ? C["ink-dim"] : C.bad;
          ctx.font = "600 11px " + css("--mono");
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(slot.actual.char, it.x + w / 2, Y_LABEL + LABEL_H / 2);
        }
      }
      if (slot.ideal && it.ix !== null) {
        var iw = (slot.ideal.t1 - slot.ideal.t0) / u * ppu;
        if (visible(it.ix, iw, v)) {
          var ig = slot.ideal.leadGap;
          if (ig) drawGap(ig, it.ix - ig.units * ppu, ig.units * ppu, Y_TGT,
                          true);
          drawMarks(slot.ideal, it.ix, Y_TGT, true);
        }
      }
    });
  }

  /* Overlay: both tracks superimposed on one absolute-time axis, each
     translucent, so alignment reads as a blend and divergence as a colored
     fringe. This is the view that shows drift directly — no drift plot needed
     to infer it. */
  function drawOverlay(v) {
    var u = M.timing.unitSec;
    var ppu = S.ppu;
    var y = Y_YOU + (OVER_H - OVER_MARK_H) / 2;

    function band(ch, x, color, alpha) {
      var bx = x;
      ch.blocks.forEach(function (b) {
        var w = b.units * ppu;
        if (b.kind !== "element-gap") {
          ctx.fillStyle = color;
          ctx.globalAlpha = alpha;
          roundRect(bx, y, Math.max(w, 2), OVER_MARK_H, 3);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        bx += w;
      });
    }

    // Target underneath, yours on top: where they coincide you see the mix,
    // where they don't you see one color alone.
    L.items.forEach(function (it) {
      var slot = it.slot;
      if (slot.ideal && it.ix !== null) {
        var iw = (slot.ideal.t1 - slot.ideal.t0) / u * ppu;
        if (visible(it.ix, iw, v)) band(slot.ideal, it.ix, C.tgt, 0.55);
      }
    });
    L.items.forEach(function (it) {
      var slot = it.slot;
      if (!slot.actual || it.x === null) return;
      var w = (slot.actual.t1 - slot.actual.t0) / u * ppu;
      if (!visible(it.x, w, v)) return;
      band(slot.actual, it.x, slot.op === "equal" ? C.you : C.bad, 0.55);
      ctx.fillStyle = slot.op === "equal" ? C["ink-dim"] : C.bad;
      ctx.font = "600 11px " + css("--mono");
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(slot.actual.char, it.x + w / 2, Y_LABEL + LABEL_H / 2);
    });

    // A leader from each character to where the target put it, so the amount
    // of slip is readable as a length rather than guessed from the fringe.
    ctx.strokeStyle = C["ink-faint"];
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    L.items.forEach(function (it) {
      var slot = it.slot;
      if (!slot.actual || !slot.ideal || it.x === null || it.ix === null) return;
      if (Math.abs(it.x - it.ix) < 2) return;
      if (!visible(Math.min(it.x, it.ix), Math.abs(it.x - it.ix), v)) return;
      var ly = Y_YOU + OVER_H - 4;
      ctx.beginPath();
      ctx.moveTo(it.ix, ly);
      ctx.lineTo(it.x, ly);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  function drawGap(gap, x, w, yTop, isTarget) {
    if (!gap || w <= 0) return;
    var y = yTop + (ROW_H - MARK_H) / 2;
    var grade = isTarget ? "none" : gradeOf(gap.units, gap.targetUnits);
    // targetKind, not kind: a long silence the intended text says is a real
    // word gap is being graded, so it must not be dimmed as a rest.
    var isPause = gap.targetKind === "pause";
    var color = isPause ? C["ink-faint"]
              : isTarget ? C.tgt
              : grade === "warn" ? C.warn : grade === "bad" ? C.bad : C.you;

    // The gap itself is drawn as a bracketed void — it's absence of tone, and
    // shading it like a mark would read as keying.
    ctx.strokeStyle = color;
    ctx.globalAlpha = isPause ? 0.5 : 0.8;
    ctx.lineWidth = 1;
    var mid = y + MARK_H / 2;
    ctx.beginPath();
    ctx.moveTo(x + 1, mid - 4); ctx.lineTo(x + 1, mid + 4);
    ctx.moveTo(x + w - 1, mid - 4); ctx.lineTo(x + w - 1, mid + 4);
    ctx.moveTo(x + 1, mid); ctx.lineTo(x + w - 1, mid);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Label char/word gaps and pauses; element gaps are self-evident.
    if (gap.kind === "element-gap" || w < 22) return;
    var label = isPause ? "pause " + gap.units.toFixed(0) + "u"
                        : fmtU(gap.units);
    ctx.font = "10px " + css("--mono");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var tw = ctx.measureText(label).width + 6;
    ctx.fillStyle = C.panel;
    ctx.fillRect(x + w / 2 - tw / 2, mid - 6, tw, 12);
    ctx.fillStyle = color;
    ctx.fillText(label, x + w / 2, mid);
  }

  function drawMarks(ch, x, yTop, isTarget) {
    var y = yTop + (ROW_H - MARK_H) / 2;
    ch.blocks.forEach(function (b) {
      var w = b.units * S.ppu;
      if (b.kind === "element-gap") {
        // A faint baseline keeps intra-character spacing visible without
        // competing with the marks.
        ctx.strokeStyle = isTarget ? C.tgt : C["ink-faint"];
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + MARK_H - 0.5);
        ctx.lineTo(x + w, y + MARK_H - 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        var grade = isTarget ? "none" : gradeOf(b.units, b.targetUnits);
        ctx.fillStyle = isTarget ? C.tgt
                      : grade === "warn" ? C.warn
                      : grade === "bad" ? C.bad : C.you;
        ctx.globalAlpha = isTarget ? 0.55 : 1;
        roundRect(x, y, Math.max(w, 2), MARK_H, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (S.hover === b) {
          ctx.strokeStyle = C.ink;
          ctx.lineWidth = 1.5;
          roundRect(x + 0.5, y + 0.5, Math.max(w, 2) - 1, MARK_H - 1, 3);
          ctx.stroke();
        }
      }
      x += w;
    });
  }

  function drawGhost(x, w, yTop) {
    var y = yTop + (ROW_H - MARK_H) / 2;
    ctx.strokeStyle = C.ghost;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    roundRect(x + 0.5, y + 0.5, Math.max(w, 2) - 1, MARK_H - 1, 3);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* The per-character verdict: worst grade among its own blocks. */
  function drawGradeStrip(slot, x, w) {
    if (!slot.actual || !slot.ideal) return;   // nothing to compare
    var worst = "ok";
    var blocks = slot.actual.blocks.slice();
    if (slot.actual.leadGap) blocks.push(slot.actual.leadGap);
    blocks.forEach(function (b) {
      var g = gradeOf(b.units, b.targetUnits);
      if (g === "bad") worst = "bad";
      else if (g === "warn" && worst !== "bad") worst = "warn";
    });
    ctx.fillStyle = C[worst];
    ctx.font = "600 9px " + css("--mono");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(GRADE_MARK[worst], x + w / 2, Y_GRADE + GRADE_H / 2);
  }

  /* Cumulative drift: how far behind/ahead of the ideal clock you've fallen.
     This is the information the per-character view necessarily hides. */
  function drawDrift(v) {
    var pts = [];
    var u = M.timing.unitSec;
    var origin = M.actual.chars.length ? M.actual.chars[0].t0 : 0;
    L.items.forEach(function (it) {
      var slot = it.slot;
      if (!slot.actual || !slot.ideal) return;
      var drift = ((slot.actual.t1 - origin) - slot.ideal.t1) / u;
      var x = S.view === "per-char"
            ? it.x + it.gapW + it.bodyW / 2
            : it.x + (slot.actual.t1 - slot.actual.t0) / u * S.ppu / 2;
      pts.push([x, drift]);
    });
    driftMax = 1;
    if (pts.length < 2) return;
    pts.forEach(function (p) { driftMax = Math.max(driftMax, Math.abs(p[1])); });

    var half = DRIFT_H / 2 - 8;
    var mid = Y_DRIFT + DRIFT_H / 2;
    ctx.strokeStyle = C.you;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var y = mid - (p[1] / driftMax) * half;
      if (i === 0) ctx.moveTo(p[0], y);
      else ctx.lineTo(p[0], y);
    });
    ctx.stroke();
  }

  /* The left band: track names and the drift axis bounds. Drawn after the
     content and outside its clip, so nothing can slide underneath. */
  function drawGutter(v) {
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, GUTTER, HEIGHT);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER - 0.5, RULER_H);
    ctx.lineTo(GUTTER - 0.5, PLOT_BOTTOM);
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "600 10px " + css("--mono");
    // In overlay the tracks share one band, so the two names stack as a
    // color key inside it rather than labeling separate rows.
    var rows = S.view === "overlay"
      ? [[Y_YOU + OVER_H / 2 - 9, "YOU", C.you],
         [Y_YOU + OVER_H / 2 + 9, "TGT", C.tgt],
         [Y_DRIFT + 7, "DRIFT", C["ink-dim"]]]
      : [[Y_YOU + ROW_H / 2, "YOU", C.you],
         [Y_TGT + ROW_H / 2, "TGT", C.tgt],
         [Y_DRIFT + 7, "DRIFT", C["ink-dim"]]];
    rows.forEach(function (row) {
      ctx.fillStyle = row[2];
      ctx.fillText(row[1], 4, row[0]);
    });

    // The axis bound goes on its own line below the label rather than at the
    // gridlines: 44px can't fit a number beside "DRIFT" without colliding,
    // and the zero rule already shows where the middle is. Up is ahead of the
    // ideal clock, down is behind.
    ctx.font = "9px " + css("--mono");
    ctx.fillStyle = C["ink-faint"];
    // Drop the decimal once it's wide, so the label can't spill past the
    // gutter at extreme drift.
    ctx.fillText("±" + driftMax.toFixed(driftMax < 10 ? 1 : 0) + "u", 4,
                 Y_DRIFT + 20);
  }

  /* A canvas-drawn scrollbar, so it matches the panel instead of the OS. */
  function scrollbarThumb(v) {
    if (!v.maxScroll) return null;
    var trackX = GUTTER, trackW = v.trackW;
    var w = Math.max(trackW * (trackW / v.contentW), 28);
    var x = trackX + (S.scrollX / v.maxScroll) * (trackW - w);
    return { x: x, w: w, trackX: trackX, trackW: trackW };
  }

  function drawScrollbar(v) {
    var th = scrollbarThumb(v);
    if (!th) return;
    var y = Y_SCROLL + 4;
    ctx.fillStyle = C.line;
    ctx.globalAlpha = 0.5;
    roundRect(th.trackX, y, th.trackW, 5, 2.5);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = C["ink-faint"];
    roundRect(th.x, y - 0.5, th.w, 6, 3);
    ctx.fill();
  }

  function drawPlayhead(v) {
    if (!S.playhead) return;
    var x = screenX(timeToX(S.playhead.t, S.playhead.side));
    if (x < GUTTER || x > v.viewW - PAD_R) return;
    // In overlay both tracks share one band, so the playhead spans all of it.
    var y0 = S.view === "overlay" ? Y_YOU
           : S.playhead.side === "you" ? Y_YOU : Y_TGT;
    var h = S.view === "overlay" ? OVER_H : ROW_H;
    ctx.strokeStyle = S.playhead.side === "you" ? C.you : C.ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y0 - 4);
    ctx.lineTo(x, y0 + h + 2);
    ctx.stroke();
  }

  // ---- audio ------------------------------------------------------------- //
  // Your recording plays from an <audio> element fed the inlined WAV; the target
  // is synthesized on the fly, so it re-renders at whatever speed the slider is
  // on rather than going stale like a baked file would.
  var actx = null, tgtNodes = null, tgtStart = 0, tgtOffset = 0, tgtDur = 0;
  var raf = null, mode = null, stopAt = null;
  var youNodes = null, youStart = 0, youOffset = 0, youDur = 0;
  var youBuffer = null, youDecoding = null;

  function audioCtx() {
    if (!actx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      actx = new Ctor();
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }

  function linGain() { return Math.pow(10, S.gainDb / 20); }

  /* Swap only a transport button's icon. Rewriting the whole label would
     resize the button and shift everything to its right. */
  function setIcon(id, glyph) {
    var ico = $(id).querySelector(".ico");
    if (ico) ico.textContent = glyph;
  }

  function applyGain() {
    if (youNodes) youNodes.level.gain.value = linGain();
    if (tgtNodes) tgtNodes.level.gain.value = linGain();
  }

  /* Decode the embedded WAV into an AudioBuffer, once.
     Deliberately not an <audio> element routed through a gain node: a
     MediaElementAudioSourceNode can output silence rather than erroring on
     some file:// / data: combinations, and a silent player is a worse failure
     than a loud one. A decoded buffer also gives exact seeking and a real
     duration, so the transport can't get stuck waiting for a rounded one. */
  function ensureBuffer() {
    if (youBuffer) return Promise.resolve(youBuffer);
    if (youDecoding) return youDecoding;
    var c = audioCtx();
    var b64 = String(P.audio).split(",")[1] || "";
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    youDecoding = new Promise(function (resolve, reject) {
      // The callback form, for older Safari.
      var p = c.decodeAudioData(bytes.buffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    }).then(function (buf) {
      youBuffer = buf;
      youDecoding = null;
      return buf;
    });
    return youDecoding;
  }

  function stopAll() {
    if (youNodes) {
      youNodes.src.onended = null;
      try { youNodes.src.stop(); } catch (e) { /* already stopped */ }
      youNodes.src.disconnect();
      youNodes.level.disconnect();
      youNodes = null;
    }
    if (tgtNodes) {
      tgtNodes.osc.onended = null;
      try { tgtNodes.osc.stop(); } catch (e) { /* already stopped */ }
      tgtNodes.osc.disconnect();
      tgtNodes.gain.disconnect();
      tgtNodes.level.disconnect();
      tgtNodes = null;
    }
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    mode = null;
    stopAt = null;
    S.playhead = null;
    $("stop").disabled = true;
    $("play-you").classList.remove("on");
    $("play-tgt").classList.remove("on");
    setIcon("play-you", "▶");
    setIcon("play-tgt", "▶");
    $("clock").textContent = "0.0s";
    draw();
  }

  function tick() {
    var c = audioCtx();
    var t = mode === "you" ? c.currentTime - youStart + youOffset
                           : c.currentTime - tgtStart + tgtOffset;
    if (stopAt !== null && t >= stopAt) { stopAll(); return; }
    // The buffer knows its own real duration, so this can't hang waiting for a
    // rounded figure the audio never reaches.
    var end = mode === "you" ? youDur : tgtDur;
    if (t >= end - 0.01) { stopAll(); return; }
    var side = mode === "you" ? "you" : "tgt";
    // Playback is scheduled a beat in the future, so the first few frames sit
    // slightly before zero — which would otherwise read as "-0.0s".
    if (t < 0) t = 0;
    S.playhead = { t: t, side: side };
    $("clock").textContent = t.toFixed(1) + "s";
    followPlayhead(timeToX(t, side));
    draw();
    raf = requestAnimationFrame(tick);
  }

  function playYou(from, to) {
    stopAll();
    $("clock").textContent = "…";
    ensureBuffer().then(function (buf) {
      var c = audioCtx();
      var src = c.createBufferSource();
      var level = c.createGain();
      src.buffer = buf;
      level.gain.value = linGain();
      src.connect(level).connect(c.destination);

      var start = Math.max(from || 0, 0);
      var dur = to === undefined ? buf.duration - start
                                 : Math.max(to - start, 0.01);
      var t0 = c.currentTime + 0.02;
      src.start(t0, start, dur);
      // The node's own end event, so a throttled frame loop can't leave the
      // transport stuck showing "playing".
      src.onended = function () { if (mode === "you") stopAll(); };

      youNodes = { src: src, level: level };
      youStart = t0;
      youOffset = start;
      youDur = to === undefined ? buf.duration : to;
      mode = "you";
      stopAt = to === undefined ? null : to;
      $("stop").disabled = false;
      $("play-you").classList.add("on");
      setIcon("play-you", "■");
      raf = requestAnimationFrame(tick);
    }).catch(function (e) {
      $("clock").textContent = "audio error";
      status("could not decode the embedded audio: " + e.message);
    });
  }

  /* Schedule the ideal keying as one oscillator with a gated envelope. The 5 ms
     raised-cosine-ish edges mirror synth.generate's ramp so it doesn't click. */
  function playTarget(from, to) {
    stopAll();
    var c = audioCtx();
    var osc = c.createOscillator();
    var gain = c.createGain();
    // A second, static node carries the listening level, so the keying
    // envelope on `gain` stays independent of it — and so the target is
    // level-matched to your recording when you A/B them.
    var level = c.createGain();
    osc.type = "sine";
    osc.frequency.value = P.tone_hz || 600;   // the tone detected in your audio
    gain.gain.value = 0;
    level.gain.value = linGain();
    osc.connect(gain).connect(level).connect(c.destination);

    var RAMP = 0.005;
    // Match the recording's own peak so A/B compares timing, not loudness; the
    // shared listening gain above then lifts both equally.
    var pk = Math.min(P.audio_peak || 0.5, 1);
    var t0 = c.currentTime + 0.06;      // a beat of headroom for scheduling

    // Playing the whole target runs from -PAD to duration+PAD, the same
    // silence the recording carries either side of its keying. Without the
    // tail, playback stopped the instant the last mark ended and cut it off.
    // Times here are timeline times, so a negative start is just lead-in.
    var full = to === undefined;
    var PAD = P.pad_sec == null ? 0.5 : P.pad_sec;
    var start = full ? -PAD : (from || 0);
    var endT = full ? M.ideal.duration + PAD : to;

    var marks = M.ideal.blocks.filter(function (b) {
      return (b.kind === "dit" || b.kind === "dah") &&
             b.t1 > start && b.t0 < endT;
    });
    marks.forEach(function (b) {
      var a = t0 + Math.max(b.t0 - start, 0);
      var z = t0 + Math.min(b.t1, endT) - start;
      if (z <= a) return;
      gain.gain.setValueAtTime(0, a);
      gain.gain.linearRampToValueAtTime(pk, a + Math.min(RAMP, (z - a) / 2));
      gain.gain.setValueAtTime(pk, Math.max(z - RAMP, a + RAMP));
      gain.gain.linearRampToValueAtTime(0, z);
    });

    tgtDur = endT;
    osc.start(t0);
    osc.stop(t0 + Math.max(endT - start, 0.05) + 0.05);
    osc.onended = function () { if (mode === "tgt") stopAll(); };
    tgtNodes = { osc: osc, gain: gain, level: level };
    tgtStart = t0;
    tgtOffset = start;
    mode = "tgt";
    stopAt = to === undefined ? null : to;
    $("stop").disabled = false;
    $("play-tgt").classList.add("on");
    setIcon("play-tgt", "■");
    raf = requestAnimationFrame(tick);
  }

  // ---- downloads --------------------------------------------------------- //
  function baseName() {
    return String(P.source || "cw-review").replace(/\.[^.]+$/, "")
             .replace(/[^\w.-]+/g, "-") || "cw-review";
  }

  function save(url, filename, revoke) {
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* Minimal 16-bit PCM WAV writer, so the target track can be handed over as a
     real file rather than something only this page can play. */
  function encodeWav(samples, rate) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var d = new DataView(buf);
    var str = function (off, s) {
      for (var i = 0; i < s.length; i++) d.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    d.setUint32(4, 36 + n * 2, true);
    str(8, "WAVEfmt ");
    d.setUint32(16, 16, true);        // fmt chunk size
    d.setUint16(20, 1, true);         // PCM
    d.setUint16(22, 1, true);         // mono
    d.setUint32(24, rate, true);
    d.setUint32(28, rate * 2, true);  // byte rate
    d.setUint16(32, 2, true);         // block align
    d.setUint16(34, 16, true);        // bits
    str(36, "data");
    d.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      d.setInt16(44 + i * 2, Math.round(s * 32767), true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  /* Render the ideal keying offline at the speed currently on the sliders —
     the same schedule playTarget() uses live, so what you download is what you
     just heard. */
  function renderTargetWav() {
    var rate = P.rate || 8000;
    // Same silence either side as a trimmed live capture, so the two files
    // are consistent and the target doesn't stop dead on its last element.
    var PAD = P.pad_sec == null ? 0.5 : P.pad_sec;
    var dur = Math.max(M.ideal.duration + 2 * PAD, 0.3);
    var Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctor) return Promise.reject(new Error("OfflineAudioContext missing"));
    var oc = new Ctor(1, Math.ceil(dur * rate), rate);
    var osc = oc.createOscillator();
    var gain = oc.createGain();
    osc.type = "sine";
    osc.frequency.value = P.tone_hz || 600;
    gain.gain.value = 0;
    osc.connect(gain).connect(oc.destination);
    var RAMP = 0.005;
    // Downloaded at the recording's own peak, so the two WAVs sit side by side
    // at matched levels — the listening gain is a page control, not a change
    // to the file.
    var pk = Math.min(P.audio_peak || 0.5, 1);
    M.ideal.blocks.forEach(function (b) {
      if (b.kind !== "dit" && b.kind !== "dah") return;
      var a = b.t0 + PAD, z = b.t1 + PAD;
      gain.gain.setValueAtTime(0, a);
      gain.gain.linearRampToValueAtTime(pk, a + Math.min(RAMP, (z - a) / 2));
      gain.gain.setValueAtTime(pk, Math.max(z - RAMP, a + RAMP));
      gain.gain.linearRampToValueAtTime(0, z);
    });
    osc.start(0);
    osc.stop(dur);
    return oc.startRendering().then(function (rendered) {
      return encodeWav(rendered.getChannelData(0), rate);
    });
  }

  /* Export the WHOLE analysis, not the visible slice: render to an offscreen
     canvas as wide as the content. Very long sessions would exceed the
     browser's canvas limit, so the zoom is reduced just enough to fit and the
     shortfall is reported rather than silently cropped. */
  // Cap the *device* pixel width: browsers limit canvas dimensions and area,
  // and a retina export doubles both.
  var MAX_PNG_DEVICE_W = 16384;
  function exportPng() {
    var wasPpu = S.ppu, wasScroll = S.scrollX, wasCanvas = canvas,
        wasCtx = ctx, wasHead = S.playhead, wasHover = S.hover;
    var note = "";
    try {
      S.playhead = null;
      S.hover = null;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var budget = MAX_PNG_DEVICE_W / dpr;
      relayoutOnly();
      var contentW = L.width;
      if (GUTTER + contentW + PAD_R > budget) {
        var fit = (budget - GUTTER - PAD_R) / contentW;
        S.ppu = Math.max(S.ppu * fit, 1);
        relayoutOnly();
        contentW = L.width;
        note = "zoomed to " + S.ppu.toFixed(1) + " px/unit so the whole "
             + "session fits";
      }
      var w = Math.ceil(GUTTER + contentW + PAD_R);
      var off = document.createElement("canvas");
      off.width = Math.round(w * dpr);
      off.height = Math.round(HEIGHT * dpr);
      canvas = off;
      ctx = off.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Opaque ground: a PNG has no page behind it to supply the background.
      ctx.fillStyle = C.panel;
      ctx.fillRect(0, 0, w, HEIGHT);
      S.scrollX = 0;
      renderOverride = { viewW: w, trackW: w - GUTTER - PAD_R,
                         contentW: contentW, maxScroll: 0 };
      draw();
      return { canvas: off, note: note };
    } finally {
      renderOverride = null;
      canvas = wasCanvas;
      ctx = wasCtx;
      S.ppu = wasPpu;
      S.scrollX = wasScroll;
      S.playhead = wasHead;
      S.hover = wasHover;
      relayout();
    }
  }

  function status(msg) {
    var el2 = $("dl-status");
    if (el2) el2.textContent = msg || "";
  }

  $("dl-you").addEventListener("click", function () {
    // Already a data: URI in the payload; hand it over as-is.
    save(P.audio, baseName() + "-yours.wav");
  });

  $("dl-tgt").addEventListener("click", function () {
    var btn = $("dl-tgt");
    btn.disabled = true;
    status("rendering target…");
    renderTargetWav().then(function (blob) {
      save(URL.createObjectURL(blob),
           baseName() + "-target-" + S.charWpm + "wpm.wav", true);
      status("");
    }).catch(function (e) {
      status("target render failed: " + e.message);
    }).then(function () { btn.disabled = false; });
  });

  $("dl-png").addEventListener("click", function () {
    var btn = $("dl-png");
    btn.disabled = true;
    status("rendering chart…");
    var out;
    try {
      out = exportPng();
    } catch (e) {
      status("chart render failed: " + e.message);
      btn.disabled = false;
      return;
    }
    var done = function (url, revoke) {
      save(url, baseName() + "-" + S.view + ".png", revoke);
      status(out.note);
      btn.disabled = false;
    };
    if (out.canvas.toBlob) {
      out.canvas.toBlob(function (blob) {
        if (blob) done(URL.createObjectURL(blob), true);
        else done(out.canvas.toDataURL("image/png"));
      }, "image/png");
    } else {
      done(out.canvas.toDataURL("image/png"));
    }
  });

  // ---- report ------------------------------------------------------------ //
  function scoreClass(v, good, ok) {
    return v >= good ? "ok" : v >= ok ? "warn" : "bad";
  }

  function renderScores() {
    var g = M.grade, c = M.compare;
    var m = P.measured;
    var parts = [];
    parts.push('<div class="score ' + scoreClass(g.withinTolFrac, .9, .75) +
               '"><b>' + Math.round(g.withinTolFrac * 100) +
               '%</b><span>consistent</span></div>');
    if (S.expected) {
      parts.push('<div class="score ' + scoreClass(c.accuracy, .95, .85) +
                 '"><b>' + (c.accuracy * 100).toFixed(1) +
                 '%</b><span>accurate</span></div>');
    }
    parts.push('<div class="score"><b>' + m.char_wpm.toFixed(1) +
               '</b><span>wpm sent (target ' + S.charWpm + ')</span></div>');
    parts.push('<div class="score"><b>' + m.farnsworth_wpm.toFixed(1) +
               '</b><span>wpm overall (target ' + S.farnsWpm + ')</span></div>');
    // The detected tone. Worth showing plainly: it's what the decoder locked
    // onto, and it's the frequency the target track is synthesized at, so a
    // wrong reading here explains a bad decode.
    parts.push('<div class="score"><b>' + Math.round(P.tone_hz) +
               '</b><span>Hz tone (target matches)</span></div>');
    var pk = P.audio_peak || 0;
    if (pk > 0) {
      parts.push('<div class="score"><b>' +
                 (20 * Math.log10(pk)).toFixed(1) +
                 '</b><span>dBFS peak · ' + (P.audio_rate / 1000) +
                 ' kHz</span></div>');
    }
    $("scores").innerHTML = parts.join("");
  }

  var LABELS = { dit: "dit", dah: "dah", "element-gap": "intra-char gap",
                 "char-gap": "character gap", "word-gap": "word gap" };

  function renderReport() {
    var g = M.grade, c = M.compare;
    var html = [];

    // Element / spacing table — the same figures cli._print_analysis prints.
    var rows = g.stats.map(function (s) {
      var grade = gradeOf(s.meanUnits, s.targetUnits);
      return "<tr><td>" + LABELS[s.name] + "</td><td class='" + grade + "'>" +
             s.meanUnits.toFixed(2) + "u</td><td>" +
             s.targetUnits.toFixed(2) + "u</td><td>±" +
             s.stdUnits.toFixed(2) + "</td><td>" + s.n + "</td>" +
             "<td class='" + grade + "'>" + GRADE_MARK[grade] + "</td></tr>";
    }).join("");
    html.push('<div class="card"><h2>Element &amp; spacing</h2><table>' +
      "<tr><th>class</th><th>yours</th><th>target</th><th>jitter</th>" +
      "<th>n</th><th></th></tr>" + rows + "</table>" +
      (g.nPauses ? '<p class="note">' + g.nPauses +
        " long inter-transmission pause(s) ignored.</p>" : "") + "</div>");

    // Worst deviations. Each value is its own play control, so you can click
    // back and forth between yours and the target and hear the difference.
    var devs = g.deviations.map(function (d) {
      var i = slotIndexAtTime(d.timeSec);
      return "<tr><td>" + d.timeSec.toFixed(2) + "s</td><td>" + d.kind +
             "</td><td class='bad play' data-side='you' data-i='" + i +
             "' title='hear yours'>" + d.valueUnits.toFixed(2) + "u ▸</td>" +
             "<td class='play' data-side='tgt' data-i='" + i +
             "' title='hear the target'>" + d.targetUnits.toFixed(2) +
             "u ▸</td><td>" + (d.context ? "after " + d.context : "") +
             "</td></tr>";
    }).join("");
    html.push('<div class="card"><h2>Largest deviations</h2>' +
      (devs ? "<table><tr><th>at</th><th>class</th><th>yours</th>" +
              "<th>target</th><th>context</th></tr>" + devs + "</table>" +
              '<p class="note">Click either value to hear it — yours or the ' +
              "target — with the characters either side for rhythm.</p>"
            : '<p class="note empty">No significant spacing deviations. ' +
              "Clean sending.</p>") + "</div>");

    // Accuracy diff, grouped into runs the way core.compare_text formats it.
    if (S.expected) {
      var out = [], runOp = null, runE = [], runG = [];
      var flush = function () {
        if (runOp === null) return;
        var e = runE.join(""), got = runG.join("");
        if (runOp === "equal") out.push('<span class="eq">' + esc(e) + "</span>");
        else if (runOp === "sub") out.push('<span class="er">[' + esc(e) +
                                          "→" + esc(got) + "]</span>");
        else if (runOp === "del") out.push('<span class="er">[-' + esc(e) +
                                          "]</span>");
        else out.push('<span class="er">[+' + esc(got) + "]</span>");
        runE = []; runG = [];
      };
      c.ops.forEach(function (o) {
        if (o[0] !== runOp) { flush(); runOp = o[0]; }
        if (o[1] !== null) runE.push(o[1]);
        if (o[2] !== null) runG.push(o[2]);
      });
      flush();
      html.push('<div class="card"><h2>Accuracy vs intended text</h2>' +
        '<p class="note">' + c.nExpected + " symbols · " +
        c.substitutions + " sub · " + c.insertions + " extra · " +
        c.deletions + " missed</p><p class=\"diff\">" + out.join("") +
        "</p></div>");
    }

    $("report").innerHTML = html.join("");
    Array.prototype.forEach.call(document.querySelectorAll("td.play"),
      function (td) {
        td.addEventListener("click", function () {
          var side = td.dataset.side;
          var w = contextWindow(side, parseInt(td.dataset.i, 10));
          if (!w) return;
          if (side === "you") playYou(w[0], w[1]);
          else playTarget(w[0], w[1]);
        });
      });
  }

  /* Which slot a moment on the recording belongs to. Deviations carry a time,
     not a character, so this is how a report row finds its counterpart on the
     target track. */
  function slotIndexAtTime(t) {
    var best = -1, bestD = Infinity;
    for (var i = 0; i < M.slots.length; i++) {
      var a = M.slots[i].actual;
      if (!a) continue;
      var from = a.leadGap ? a.leadGap.t0 : a.t0;
      if (t >= from - 1e-9 && t <= a.t1 + 1e-9) return i;
      var d = Math.min(Math.abs(from - t), Math.abs(a.t1 - t));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* A play window covering the slot plus its neighbours. Spacing is only
     audible in context: to judge a gap you need the character before it, the
     gap, and the character after. */
  function contextWindow(side, idx) {
    if (!(idx >= 0)) return null;
    var pad = 0.08;
    var lo = Math.max(idx - 1, 0);
    var hi = Math.min(idx + 1, M.slots.length - 1);
    var first = null, last = null;
    for (var i = lo; i <= hi; i++) {
      var c = side === "you" ? M.slots[i].actual : M.slots[i].ideal;
      if (!c) continue;
      if (!first) first = c;
      last = c;
    }
    if (!first) return null;
    return [Math.max(first.t0 - pad, 0), last.t1 + pad];
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
  }

  // ---- hit testing ------------------------------------------------------- //
  function hit(mx, my) {
    if (mx < GUTTER) return null;             // the label band isn't content
    var x = contentX(mx);
    // In overlay the tracks occupy the same band, so split it: the upper half
    // picks yours, the lower half the target.
    var overlayRow = my >= Y_YOU && my < Y_YOU + OVER_H
      ? (my < Y_YOU + OVER_H / 2 ? "you" : "tgt") : null;
    for (var i = 0; i < L.items.length; i++) {
      var it = L.items[i];
      var slot = it.slot;
      var row = S.view === "overlay" ? overlayRow
              : my >= Y_YOU && my < Y_YOU + ROW_H ? "you"
              : my >= Y_TGT && my < Y_TGT + ROW_H ? "tgt" : null;
      if (!row) continue;
      var ch = row === "you" ? slot.actual : slot.ideal;
      if (!ch) continue;

      var bx, gap = ch.leadGap;
      if (S.view === "per-char") {
        bx = it.x + it.gapW;
        if (gap && x >= it.x && x < it.x + (row === "you" ? it.youGapW
                                                          : it.tgtGapW)) {
          return { block: gap, char: ch, row: row, slot: slot };
        }
      } else {
        bx = row === "you" ? it.x : it.ix;
        // A slot with no character on this side has no x; comparing against
        // null would coerce to 0 and match everything to its left.
        if (bx === null || bx === undefined) continue;
        var gw = gap ? gap.units * S.ppu : 0;
        if (gap && x >= bx - gw && x < bx) {
          return { block: gap, char: ch, row: row, slot: slot };
        }
      }
      for (var j = 0; j < ch.blocks.length; j++) {
        var b = ch.blocks[j];
        var w = b.units * S.ppu;
        if (x >= bx && x < bx + w) {
          return { block: b, char: ch, row: row, slot: slot };
        }
        bx += w;
      }
    }
    return null;
  }

  var MS = { dit: "dit", dah: "dah", "element-gap": "intra-character gap",
             "char-gap": "character gap", "word-gap": "word gap",
             pause: "pause" };

  // ---- pointer interaction ----------------------------------------------- //
  // One gesture model for the whole canvas: press, then either drag (pan, or
  // move the scrollbar thumb) or release without moving (a click).
  var drag = null;
  var suppressClick = false;   // set by a pan, consumed by the click after it
  var DRAG_SLOP = 4;           // px before a press becomes a pan

  function localPos(ev) {
    var r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  canvas.addEventListener("mousedown", function (ev) {
    var p = localPos(ev);
    var v = viewport();
    suppressClick = false;
    var th = scrollbarThumb(v);
    if (th && p.y >= Y_SCROLL) {
      if (p.x >= th.x && p.x <= th.x + th.w) {
        drag = { kind: "thumb", x0: p.x, scroll0: S.scrollX, th: th, moved: 0 };
      } else {
        // Clicking the bare track pages toward the click.
        scrollTo(S.scrollX + (p.x < th.x ? -v.trackW : v.trackW) * 0.8);
      }
      ev.preventDefault();
      return;
    }
    if (p.x < GUTTER || p.y < RULER_H) return;   // gutter and ruler aren't pans
    drag = { kind: "pan", x0: p.x, scroll0: S.scrollX, moved: 0 };
  });

  window.addEventListener("mousemove", function (ev) {
    if (!drag) return;
    var p = localPos(ev);
    var dx = p.x - drag.x0;
    drag.moved = Math.max(drag.moved, Math.abs(dx));
    if (drag.moved < DRAG_SLOP) return;
    var v = viewport();
    if (drag.kind === "thumb") {
      var span = drag.th.trackW - drag.th.w;
      scrollTo(drag.scroll0 + (span > 0 ? dx / span * v.maxScroll : 0));
    } else {
      canvas.classList.add("grabbing");
      scrollTo(drag.scroll0 - dx);
    }
  });

  // Always clear `drag` here — a release outside the canvas fires no click, and
  // a stuck drag would suppress hovering indefinitely. Whether it counted as a
  // pan is handed to the click that may follow.
  window.addEventListener("mouseup", function () {
    if (!drag) return;
    canvas.classList.remove("grabbing");
    suppressClick = drag.moved >= DRAG_SLOP;
    drag = null;
  });

  canvas.addEventListener("mousemove", function (ev) {
    if (drag && drag.moved >= DRAG_SLOP) { tip.hidden = true; return; }
    var p = localPos(ev);
    var h = hit(p.x, p.y);
    var b = h ? h.block : null;
    if (b !== S.hover) { S.hover = b; draw(); }
    if (!h) { tip.hidden = true; return; }
    var ms = b.units * M.timing.unitSec * 1000;
    // Name the class it's graded as, so the target figure below makes sense,
    // and say what the decoder actually read when the two disagree.
    var lines = ["<b>" + esc(h.char.char) + "</b> — " + MS[b.targetKind],
                 ms.toFixed(0) + " ms / " + b.units.toFixed(2) + "u"];
    if (b.targetUnits > 0 && h.row === "you") {
      var pct = (b.units / b.targetUnits - 1) * 100;
      lines.push("target " + b.targetUnits.toFixed(2) + "u (" +
                 (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%)");
    }
    if (b.targetKind !== b.kind) lines.push("read as " + MS[b.kind]);
    if (h.row === "you") lines.push("at " + b.t0.toFixed(2) + "s");
    tip.innerHTML = lines.join("<br>");
    tip.hidden = false;
    tip.style.left = Math.min(ev.clientX + 14,
                              window.innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = (ev.clientY + 16) + "px";
  });

  canvas.addEventListener("mouseleave", function () {
    tip.hidden = true;
    if (S.hover) { S.hover = null; draw(); }
  });

  canvas.addEventListener("click", function (ev) {
    // A press that turned into a pan is not a click.
    if (suppressClick) { suppressClick = false; return; }

    var p = localPos(ev);
    if (p.x < GUTTER || p.y >= Y_SCROLL) return;

    // The ruler band is a seek strip.
    if (p.y < RULER_H) {
      playYou(Math.max(xToTime(contentX(p.x), "you"), 0));
      return;
    }
    var h = hit(p.x, p.y);
    if (!h) return;
    // Click a character to hear just that character, on whichever track.
    var pad = 0.08;
    if (h.row === "you") playYou(Math.max(h.char.t0 - pad, 0), h.char.t1 + pad);
    else playTarget(Math.max(h.char.t0 - pad, 0), h.char.t1 + pad);
  });

  canvas.addEventListener("wheel", function (ev) {
    var v = viewport();
    if (!v.maxScroll) return;
    // There's nothing to scroll vertically, so a plain wheel pans.
    var d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    if (!d) return;
    ev.preventDefault();
    scrollTo(S.scrollX + d);
  }, { passive: false });

  // ---- controls ---------------------------------------------------------- //
  function bindRange(id, outId, get, set, fmt) {
    var input = $(id), out = $(outId);
    input.value = get();
    out.textContent = fmt(get());
    input.addEventListener("input", function () {
      set(parseFloat(input.value));
      out.textContent = fmt(get());
      recompute();          // ends in relayout -> resize -> draw
    });
    return input;
  }

  bindRange("wpm", "wpm-out",
    function () { return S.charWpm; },
    function (v) {
      S.charWpm = v;
      // Overall speed can't exceed character speed; drag it along.
      if (S.farnsWpm > v) { S.farnsWpm = v; $("farns").value = v;
                            $("farns-out").textContent = v + " wpm"; }
      $("farns").max = v;
    },
    function (v) { return v + " wpm"; });

  bindRange("farns", "farns-out",
    function () { return S.farnsWpm; },
    function (v) { S.farnsWpm = Math.min(v, S.charWpm); },
    function (v) { return v + " wpm"; });
  $("farns").max = S.charWpm;

  bindRange("tol", "tol-out",
    function () { return Math.round(S.tolerance * 100); },
    function (v) { S.tolerance = v / 100; },
    function (v) { return v + "%"; });

  // Level is playback-only, so it needs no recompute or redraw.
  (function () {
    var input = $("gain"), out = $("gain-out");
    var show = function () {
      out.textContent = (S.gainDb > 0 ? "+" : "") + S.gainDb + " dB";
    };
    input.value = S.gainDb;
    show();
    input.addEventListener("input", function () {
      S.gainDb = parseFloat(input.value);
      show();
      applyGain();
    });
  })();

  bindRange("zoom", "zoom-out",
    function () { return S.ppu; },
    function (v) {
      // Zoom about the middle of the view, so you don't lose your place.
      var vp = viewport();
      var anchor = (S.scrollX + vp.trackW / 2) / Math.max(S.ppu, 0.001);
      S.ppu = v;
      S.scrollX = anchor * v - vp.trackW / 2;
    },
    function (v) { return v + " px/unit"; });

  var expIn = $("expected");
  expIn.value = S.expected;
  expIn.addEventListener("input", function () {
    S.expected = expIn.value.toUpperCase();
    recompute();
  });

  $("view").addEventListener("change", function () {
    S.view = $("view").value;
    S.scrollX = 0;
    relayout();           // ends in resize -> draw
  });

  $("play-you").addEventListener("click", function () {
    if (mode === "you") stopAll(); else playYou(0);
  });
  $("play-tgt").addEventListener("click", function () {
    if (mode === "tgt") stopAll(); else playTarget(0);
  });
  $("stop").addEventListener("click", stopAll);

  document.addEventListener("keydown", function (ev) {
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT") return;
    var v = viewport();
    if (ev.code === "Space") {
      ev.preventDefault();
      if (mode) stopAll(); else playYou(0);
    } else if (ev.key === "t") {
      if (mode === "tgt") stopAll(); else playTarget(0);
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault(); scrollTo(S.scrollX - v.trackW * 0.25);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault(); scrollTo(S.scrollX + v.trackW * 0.25);
    } else if (ev.key === "Home") {
      ev.preventDefault(); scrollTo(0);
    } else if (ev.key === "End") {
      ev.preventDefault(); scrollTo(v.maxScroll);
    }
  });

  window.addEventListener("resize", resize);
  var mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", function () { readColors(); draw(); });

  // ---- boot -------------------------------------------------------------- //
  $("src").textContent = P.source;
  $("exp-src").textContent = P.expected_source
    ? "from " + P.expected_source
    : P.expected ? "" : "(no target supplied — using your own decode)";
  document.title = "CW review — " + P.source;

  readColors();
  recompute();
})();
