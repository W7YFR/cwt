/* Aligning a decode against the intended message.
 *
 * Levenshtein rather than difflib's ratcheting match, because CW practice text
 * is repetitive — a call sent five times — and a greedy matcher anchors on the
 * wrong repetition and reports a cascade of errors where there was one.
 */

import type { AlignOp, Comparison, EditOp } from "@/types";
import { tokenize } from "@/morse";

/** Above this many cells the full DP matrix is not worth allocating; the
 *  banded fallback below takes over. A minute of 25 wpm sending is about 150
 *  tokens, so real input never comes close. */
const FULL_DP_LIMIT = 4_000_000;

/** Optimal alignment of token list `a` (expected) to `b` (decoded). */
export function align(a: readonly string[], b: readonly string[]): AlignOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n * m > FULL_DP_LIMIT) return alignGreedy(a, b);

  const w = m + 1;
  const d = new Int32Array((n + 1) * w);
  for (let i = 0; i <= n; i++) d[i * w] = i;
  for (let j = 0; j <= m; j++) d[j] = j;

  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = i * w;
    const prev = row - w;
    for (let j = 1; j <= m; j++) {
      const sub = d[prev + j - 1]! + (ai === b[j - 1] ? 0 : 1);
      const del = d[prev + j]! + 1;
      const ins = d[row + j - 1]! + 1;
      d[row + j] = Math.min(sub, del, ins);
    }
  }

  // Walk back, preferring diagonal moves so a substitution reads as one edit
  // rather than a delete next to an insert.
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      d[i * w + j] === d[(i - 1) * w + j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
    ) {
      ops.push({
        op: a[i - 1] === b[j - 1] ? "equal" : "sub",
        a: a[i - 1]!,
        b: b[j - 1]!,
      });
      i--;
      j--;
    } else if (i > 0 && d[i * w + j] === d[(i - 1) * w + j]! + 1) {
      ops.push({ op: "del", a: a[i - 1]!, b: null });
      i--;
    } else {
      ops.push({ op: "ins", a: null, b: b[j - 1]! });
      j--;
    }
  }
  ops.reverse();
  return ops;
}

/** Linear-time fallback for pathological input. Never optimal, but it always
 *  terminates and it only runs on text far longer than any real transmission. */
function alignGreedy(a: readonly string[], b: readonly string[]): AlignOp[] {
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push({ op: "equal", a: a[i]!, b: b[j]! });
    else ops.push({ op: "sub", a: a[i]!, b: b[j]! });
    i++;
    j++;
  }
  while (i < a.length) ops.push({ op: "del", a: a[i++]!, b: null });
  while (j < b.length) ops.push({ op: "ins", a: null, b: b[j++]! });
  return ops;
}

/** Group consecutive same-op runs, for rendering a compact diff. */
export function diffRuns(ops: readonly AlignOp[]): Array<{
  op: EditOp;
  expected: string;
  got: string;
}> {
  const runs: Array<{ op: EditOp; expected: string; got: string }> = [];
  for (const o of ops) {
    const last = runs[runs.length - 1];
    if (last && last.op === o.op) {
      last.expected += o.a ?? "";
      last.got += o.b ?? "";
    } else {
      runs.push({ op: o.op, expected: o.a ?? "", got: o.b ?? "" });
    }
  }
  return runs;
}

/** The inline annotated diff, e.g. `CQ DE [W7YFR→W7YFP]`. */
export function diffText(ops: readonly AlignOp[]): string {
  return diffRuns(ops)
    .map((r) => {
      switch (r.op) {
        case "equal":
          return r.expected;
        case "sub":
          return `[${r.expected}→${r.got}]`;
        case "del":
          return `[-${r.expected}]`;
        case "ins":
          return `[+${r.got}]`;
      }
    })
    .join("");
}

/** Align the decoded text against the intended text and score accuracy. */
export function compareText(expected: string, decoded: string): Comparison {
  const exp = tokenize(expected);
  const got = tokenize(decoded);
  const ops = align(exp, got);

  let matches = 0;
  let subs = 0;
  let ins = 0;
  let dels = 0;
  for (const o of ops) {
    if (o.op === "equal") matches++;
    else if (o.op === "sub") subs++;
    else if (o.op === "del") dels++;
    else ins++;
  }

  const collapse = (s: string) => s.toUpperCase().trim().split(/\s+/).join(" ");

  return {
    expected: collapse(expected),
    decoded: collapse(decoded),
    accuracy: exp.length ? matches / exp.length : 1,
    nExpected: exp.length,
    substitutions: subs,
    insertions: ins,
    deletions: dels,
    diff: diffText(ops),
    ops,
  };
}
