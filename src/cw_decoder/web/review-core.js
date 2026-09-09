/* review-core.js — the grading logic, mirrored from core.py.
 *
 * This is deliberately a port rather than a re-imagining: every function here
 * has a named counterpart in core.py, and tests/test_web_review.py runs both
 * over the same fixture and asserts they agree to 1e-9. If you change one side,
 * change the other and let that test tell you if you drifted.
 *
 * Why a port at all? So the page can re-grade at any target speed, Farnsworth
 * spacing, tolerance, or intended message without a server round-trip. The one
 * thing it cannot redo is the DSP that produced the segments — those arrive
 * from Python already measured, in seconds.
 *
 * No DOM access in this file; it loads in both the browser and node.
 */
(function (root) {
  "use strict";

  // Injected at page-build time from morse.py so the tables can't drift.
  var MORSE = { charToMorse: {}, morseToChar: {} };

  function setMorse(tables) { MORSE = tables; }

  var TOKEN = /<[A-Z]+>|[\s\S]/g;

  // core.PAUSE_FACTOR
  var PAUSE_FACTOR = 2.0;
  var CLASS_ORDER = ["dit", "dah", "element-gap", "char-gap", "word-gap"];

  // --- morse.decode_pattern ------------------------------------------------ //
  function decodePattern(pattern) {
    var ch = MORSE.morseToChar[pattern];
    return ch === undefined ? "?" : ch;
  }

  // --- core.target_timing -------------------------------------------------- //
  // Standard PARIS + KE3Z Farnsworth model: the extra spacing time Ta is spread
  // over PARIS's 19 spacing units, and degenerates to one unit when S == C.
  function targetTiming(charWpm, farnsWpm) {
    if (farnsWpm === null || farnsWpm === undefined) farnsWpm = charWpm;
    farnsWpm = Math.min(farnsWpm, charWpm);
    var unit = 1.2 / charWpm;
    var ta = 60.0 / farnsWpm - 37.2 / charWpm;
    var fwUnit = Math.max(ta / 19.0, unit);
    return {
      unitSec: unit,
      charWpm: charWpm,
      farnsworthWpm: farnsWpm,
      ditDahSplit: 2.0 * unit,
      elementCharSplit: 2.0 * unit,
      charWordSplit: 5.0 * fwUnit,
      charGapSec: 3.0 * fwUnit,
      wordGapSec: 7.0 * fwUnit
    };
  }

  function block(t0, t1, kind, units, targetUnits, context) {
    return { t0: t0, t1: t1, kind: kind, units: units,
             targetUnits: targetUnits, context: context || "" };
  }

  // --- core.build_timeline ------------------------------------------------- //
  // `segments` is [[state, seconds], ...] straight from the payload, so the
  // browser re-derives the decode itself: changing the target speed can legally
  // change what the recording decodes to, and that should be visible.
  function buildTimeline(segments, timing) {
    var u = timing.unitSec;
    var charGapU = timing.charGapSec ? timing.charGapSec / u : 3.0;
    var wordGapU = timing.wordGapSec ? timing.wordGapSec / u : 7.0;
    var pauseFloor = PAUSE_FACTOR * wordGapU;

    var text = [], chars = [], blocks = [];
    var pending = [], pattern = [], lead = null;
    var t = 0.0, n = segments.length;

    // A character ends at its own last mark, never at the current cursor: `t`
    // has already advanced past the gap that triggered the flush, and after the
    // loop it sits beyond the trailing silence. Reading the end off `pending`
    // keeps that silence out of the character's span.
    function flush() {
      if (!pattern.length) return;
      var pat = pattern.join("");
      var ch = decodePattern(pat);
      text.push(ch);
      chars.push({ char: ch, pattern: pat, t0: pending[0].t0,
                   t1: pending[pending.length - 1].t1,
                   blocks: pending, leadGap: lead });
      pending = []; pattern = []; lead = null;
    }
    function tail() { return text.join("").slice(-10).trim(); }

    for (var i = 0; i < n; i++) {
      var state = segments[i][0], dur = segments[i][1];
      var start = t;
      t += dur;
      var vu = dur / u;
      if (state === 1) {                       // mark
        var isDit = dur < timing.ditDahSplit;
        pattern.push(isDit ? "." : "-");
        var b = block(start, t, isDit ? "dit" : "dah", vu, isDit ? 1.0 : 3.0);
        pending.push(b); blocks.push(b);
      } else {                                 // gap
        // The very first and last silences aren't spacing.
        if (i === 0 || i === n - 1) continue;
        if (dur < timing.elementCharSplit) {
          var g = block(start, t, "element-gap", vu, 1.0);
          pending.push(g); blocks.push(g);
        } else if (dur < timing.charWordSplit) {
          flush();
          lead = block(start, t, "char-gap", vu, charGapU, tail());
          blocks.push(lead);
        } else {
          flush();
          var isPause = vu > pauseFloor;
          lead = block(start, t, isPause ? "pause" : "word-gap", vu,
                       isPause ? 0.0 : wordGapU, tail());
          blocks.push(lead);
          text.push(" ");
        }
      }
    }
    flush();
    return { text: text.join(""), chars: chars, blocks: blocks };
  }

  // --- the ideal keying, same shape as a decoded timeline ------------------ //
  // Mirrors how synth.generate lays out its on/off list, so "perfect" here is
  // exactly what the synthesizer would have produced.
  function keyableSymbols(word) {
    var out = [], m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(word)) !== null) {
      if (MORSE.charToMorse[m[0]] !== undefined) out.push(m[0]);
    }
    return out;
  }

  function idealTimeline(text, timing) {
    var u = timing.unitSec;
    var charGap = timing.charGapSec, wordGap = timing.wordGapSec;
    var chars = [], blocks = [], t = 0.0;
    var words = String(text || "").toUpperCase().trim().split(/\s+/)
                  .filter(function (w) { return w.length > 0; });

    words.forEach(function (word, wi) {
      var lead = null;
      if (wi > 0) {
        lead = block(t, t + wordGap, "word-gap", wordGap / u, wordGap / u);
        blocks.push(lead); t += wordGap;
      }
      keyableSymbols(word).forEach(function (ch, li) {
        if (li > 0) {
          lead = block(t, t + charGap, "char-gap", charGap / u, charGap / u);
          blocks.push(lead); t += charGap;
        }
        var pat = MORSE.charToMorse[ch], pending = [], c0 = t;
        for (var ei = 0; ei < pat.length; ei++) {
          if (ei > 0) {
            var g = block(t, t + u, "element-gap", 1.0, 1.0);
            pending.push(g); blocks.push(g); t += u;
          }
          var isDit = pat[ei] === ".";
          var d = isDit ? u : 3 * u;
          var b = block(t, t + d, isDit ? "dit" : "dah",
                        isDit ? 1.0 : 3.0, isDit ? 1.0 : 3.0);
          pending.push(b); blocks.push(b); t += d;
        }
        chars.push({ char: ch, pattern: pat, t0: c0, t1: t,
                     blocks: pending, leadGap: lead });
        lead = null;
      });
    });
    return { text: words.join(" "), chars: chars, blocks: blocks,
             duration: t };
  }

  // --- core.analyze -------------------------------------------------------- //
  function grade(timeline, tolerance) {
    var nPauses = 0, graded = [];
    timeline.blocks.forEach(function (b) {
      if (b.kind === "pause") nPauses++;
      if (b.targetUnits > 0) graded.push(b);
    });

    var groups = {};
    graded.forEach(function (b) {
      if (!groups[b.kind]) groups[b.kind] = { vals: [], target: b.targetUnits };
      groups[b.kind].vals.push(b.units);
    });

    var stats = [];
    CLASS_ORDER.forEach(function (kind) {
      var g = groups[kind];
      if (!g) return;
      var n = g.vals.length;
      var mean = g.vals.reduce(function (a, v) { return a + v; }, 0) / n;
      // Population std, matching numpy's ddof=0 default.
      var varr = g.vals.reduce(function (a, v) {
        return a + (v - mean) * (v - mean);
      }, 0) / n;
      stats.push({ name: kind, n: n, meanUnits: mean,
                   stdUnits: Math.sqrt(varr), targetUnits: g.target });
    });

    var within = 0, devs = [];
    graded.forEach(function (b) {
      var abs = Math.abs(b.units - b.targetUnits);
      if (abs / b.targetUnits <= tolerance) within++;
      // Flag a deviation only if it's both proportionally and absolutely off,
      // so 1-unit elements aren't flagged for tiny wobble.
      else if (abs >= 0.4) {
        devs.push({ timeSec: b.t0, kind: b.kind, valueUnits: b.units,
                    targetUnits: b.targetUnits, context: b.context });
      }
    });
    devs.sort(function (x, y) {
      return Math.abs(y.valueUnits - y.targetUnits) / y.targetUnits -
             Math.abs(x.valueUnits - x.targetUnits) / x.targetUnits;
    });

    return {
      stats: stats,
      deviations: devs.slice(0, 12),
      withinTolFrac: graded.length ? within / graded.length : 1.0,
      nPauses: nPauses,
      tolerance: tolerance
    };
  }

  // --- core._tokenize / _align / compare_text ------------------------------ //
  function tokenize(text) {
    var collapsed = String(text || "").toUpperCase().trim().split(/\s+/)
                      .join(" ");
    var out = [], m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(collapsed)) !== null) out.push(m[0]);
    return out;
  }

  // Optimal Levenshtein alignment, with the same traceback preference as
  // core._align (diagonal, then delete, then insert) so both sides report the
  // same edits on ties.
  function align(a, b) {
    var n = a.length, m = b.length, i, j;
    var d = [];
    for (i = 0; i <= n; i++) {
      d.push(new Int32Array(m + 1));
      d[i][0] = i;
    }
    for (j = 0; j <= m; j++) d[0][j] = j;
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        var sub = d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
        d[i][j] = Math.min(sub, d[i - 1][j] + 1, d[i][j - 1] + 1);
      }
    }
    i = n; j = m;
    var ops = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 &&
          d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
        ops.push([a[i - 1] === b[j - 1] ? "equal" : "sub", a[i - 1], b[j - 1]]);
        i--; j--;
      } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
        ops.push(["del", a[i - 1], null]);
        i--;
      } else {
        ops.push(["ins", null, b[j - 1]]);
        j--;
      }
    }
    ops.reverse();
    return ops;
  }

  function compare(expected, decoded) {
    var exp = tokenize(expected), got = tokenize(decoded);
    var ops = align(exp, got);
    var matches = 0, subs = 0, ins = 0, dels = 0;
    ops.forEach(function (o) {
      if (o[0] === "equal") matches++;
      else if (o[0] === "sub") subs++;
      else if (o[0] === "del") dels++;
      else ins++;
    });
    return {
      ops: ops,
      accuracy: exp.length ? matches / exp.length : 1.0,
      nExpected: exp.length,
      substitutions: subs, insertions: ins, deletions: dels
    };
  }

  // --- pairing two timelines for side-by-side rendering -------------------- //
  // Align on the same token stream compare() uses — characters plus explicit
  // spaces — so the page's accuracy figure matches the CLI's, then fold each
  // space op onto the character that follows it. A word-boundary error is then
  // visible twice: as `spaceOp` on the slot, and as that slot's own gap being
  // the wrong length.
  function tokenStream(tl) {
    var out = [];
    tl.chars.forEach(function (c) {
      var g = c.leadGap;
      if (g && (g.kind === "word-gap" || g.kind === "pause")) {
        out.push({ tok: " ", char: null });
      }
      out.push({ tok: c.char, char: c });
    });
    return out;
  }

  function pair(actual, ideal) {
    var A = tokenStream(actual), B = tokenStream(ideal);
    var ops = align(B.map(function (x) { return x.tok; }),      // expected
                    A.map(function (x) { return x.tok; }));     // got
    var slots = [], bi = 0, ai = 0, pendingSpace = null;

    ops.forEach(function (o) {
      var op = o[0];
      var idealItem = o[1] !== null ? B[bi++] : null;
      var actualItem = o[2] !== null ? A[ai++] : null;
      // A space token carries no character; it only reports whether the word
      // boundary landed where it should, which we hang on the next character.
      if (idealItem && idealItem.char === null) {
        pendingSpace = actualItem && actualItem.char === null ? op : "del";
        idealItem = null;
      }
      if (actualItem && actualItem.char === null) {
        if (pendingSpace === null) pendingSpace = "ins";
        actualItem = null;
      }
      if (!idealItem && !actualItem) return;
      // A space aligned against a character leaves one side empty, so the
      // character's own verdict is no longer `op` — it's an extra or a miss.
      if (!idealItem) op = "ins";
      else if (!actualItem) op = "del";
      slots.push({
        op: op,
        actual: actualItem ? actualItem.char : null,
        ideal: idealItem ? idealItem.char : null,
        spaceOp: pendingSpace
      });
      pendingSpace = null;
    });
    return slots;
  }

  var api = {
    PAUSE_FACTOR: PAUSE_FACTOR,
    CLASS_ORDER: CLASS_ORDER,
    setMorse: setMorse,
    decodePattern: decodePattern,
    targetTiming: targetTiming,
    buildTimeline: buildTimeline,
    idealTimeline: idealTimeline,
    grade: grade,
    tokenize: tokenize,
    align: align,
    compare: compare,
    pair: pair
  };

  root.ReviewCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
