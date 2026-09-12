/* Envelope -> (state, duration) runs.
 *
 * Ported from core.py's run_lengths / debounce. The durations are in seconds
 * from here on; the sample rate does not survive this boundary, which is what
 * lets a 48 kHz recording and a synthesized 8 kHz target share one timeline.
 */

import type { Segment } from "@/types";

/** Run-length encode a key-down/key-up decision at `rate`. */
export function runLengths(
  binary: Uint8Array | boolean[],
  rate: number,
): Segment[] {
  const n = binary.length;
  if (n === 0) return [];
  const at = (i: number) => (binary[i] ? 1 : 0);

  const out: Segment[] = [];
  let start = 0;
  let state = at(0);
  for (let i = 1; i < n; i++) {
    const s = at(i);
    if (s !== state) {
      out.push([state as 0 | 1, (i - start) / rate]);
      start = i;
      state = s;
    }
  }
  out.push([state as 0 | 1, (n - start) / rate]);
  return out;
}

/** Drop runs shorter than `minDur` by merging them into their neighbors.
 *
 * A dropped sample, a click, or a moment of key bounce shows up as a run far
 * shorter than any real element. Removing one joins the same-state runs either
 * side of it into a single run, which is what a clean recording would have had.
 *
 * Repeatedly removes the *first* sub-threshold run and re-scans, matching the
 * Python implementation exactly: a single pass would let a merge create a new
 * short run and leave it in place. */
export function debounce(segs: readonly Segment[], minDur: number): Segment[] {
  let out = segs.slice();
  if (out.length === 0) return out;

  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const seg = out[i]!;
      if (seg[1] >= minDur) continue;
      const dur = seg[1];
      const left = i > 0 ? out[i - 1]! : null;
      const right = i + 1 < out.length ? out[i + 1]! : null;
      if (left && right) {
        const merged: Segment = [left[0], left[1] + dur + right[1]];
        out = [...out.slice(0, i - 1), merged, ...out.slice(i + 2)];
      } else if (left) {
        out = [...out.slice(0, i - 1), [left[0], left[1] + dur] as Segment];
      } else if (right) {
        out = [[right[0], right[1] + dur] as Segment, ...out.slice(i + 2)];
      } else {
        out = [...out.slice(0, i), ...out.slice(i + 1)];
      }
      changed = true;
      break;
    }
  }
  return out;
}

/** The p-th percentile of `values`, linearly interpolated (numpy's default). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const idx = ((v.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return v[lo]!;
  return v[lo]! + (v[hi]! - v[lo]!) * (idx - lo);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
