/* Where a mark really begins and ends.
 *
 * Segmentation asks which elements exist; this asks where they are. The two
 * want different things from a threshold, and one threshold cannot give both.
 *
 * For detection, the threshold wants to sit clear of the noise. For
 * measurement it wants to sit at half the mark's height, because that is the
 * only place where the rising and falling edges err by the same amount and the
 * errors cancel. On a clean recording those coincide closely enough not to
 * matter — the keying threshold lands around 55% of the mark and the edges are
 * near-symmetric, so the measurement comes out right whatever height it was
 * taken at.
 *
 * Through a microphone they come apart badly. Reverberation lifts the level
 * between elements, which drags the threshold up the mark — measured at 75% of
 * peak on a webcam recording against 55% on a loopback capture. High on the
 * edge, a rise is crossed late and a fall is crossed early, so every mark
 * closes in from both sides: dits read 34 ms where they were sent at 47, and
 * the dit-to-dah ratio comes out at 3.9 against a true 3.0. The app would tell
 * someone their dits were clipped when nothing of the sort had happened.
 *
 * So each edge is re-placed at half the *steady* level, and steady is the
 * important word. A short mark heard through a room never reaches full
 * amplitude — the reverberant field is still building when the key comes up —
 * so a dit peaks below a dah even though both were sent at one level. Measured
 * here: identical on a loopback capture, 96% on a webcam, 85% on a condenser
 * across a room. Halving each mark's own peak would therefore use a lower
 * reference for dits than for dahs and bake the room's buildup into the dit
 * length. The local peak — what a long mark nearby reaches — is the level the
 * sender actually keyed, and it is the right reference for all of them.
 *
 * The correction is weighted by how slow the edges are, so it fades to nothing
 * on a recording that never needed it. That is what keeps clean audio decoding
 * exactly as it did: not a gate choosing between two pipelines, but a
 * correction whose own magnitude is zero when the thing it corrects is absent.
 */

import type { Segment } from "@/types";
import { SMOOTH_SEC } from "./envelope";

/** Levels the edge time is measured between, as fractions of the steady level.
 *
 * Deliberately well inside the mark. Measuring 10% to 90% would be the usual
 * convention, but the 10% point of a reverberant mark lies out in the previous
 * element's tail, so the measurement would be of the neighborhood rather than
 * of the edge. */
const EDGE_LO = 0.3;
const EDGE_HI = 0.7;

/** The height an edge is measured at: half the steady level.
 *
 * Half, because that is where a symmetric rise and fall make equal and
 * opposite errors. Nothing else about the edge shape has to be known or
 * assumed for that to hold. */
const MEASURE_AT = 0.5;

/** How slow an edge has to be before it is worth correcting.
 *
 * The envelope is smoothed over SMOOTH_SEC, and that smoothing has a
 * transition time of its own — about 0.4 of the window between the levels
 * above. An edge measured faster than that is not a property of the signal at
 * all; it is the instrument's own response, and there is nothing in it to
 * correct. The factor of three puts the floor clear of that instrument
 * response while staying far below anything a room produces.
 *
 * Measured across the corpus: synthesized signals sit at exactly 2.50 ms, the
 * smoother's own figure. Real clean recordings reach 3.4 ms. Microphone
 * recordings start at 10.8 ms. The floor lands in the empty space between. */
export function slowEdgeFloorSec(): number {
  return 3 * 0.4 * SMOOTH_SEC;
}

interface Run {
  readonly state: 0 | 1;
  readonly from: number;
  readonly to: number;
}

function runsOf(binary: Uint8Array): Run[] {
  const out: Run[] = [];
  let i = 0;
  while (i < binary.length) {
    let j = i;
    while (j < binary.length && binary[j] === binary[i]) j++;
    out.push({ state: binary[i] === 1 ? 1 : 0, from: i, to: j });
    i = j;
  }
  return out;
}

/** First index at or beyond `from`, walking in `dir`, where the envelope is on
 *  the far side of `frac` of the local steady level. Bounded, so a mark that
 *  never gets there cannot walk off into the next one. */
function cross(
  env: Float32Array,
  peak: Float32Array,
  from: number,
  dir: 1 | -1,
  frac: number,
  wantAbove: boolean,
  limit: number,
): number {
  let k = from;
  for (let n = 0; n < limit; n++) {
    const next = k + dir;
    if (next < 0 || next >= env.length) break;
    if (env[k]! >= frac * peak[k]! === wantAbove) break;
    k = next;
  }
  return k;
}

/** Median time an edge takes to cross between EDGE_LO and EDGE_HI, in seconds.
 *
 * The signal's own edge rate, and the quantity that says whether any of this
 * is needed. Returns 0 when there is nothing to measure. */
export function edgeTransitionSec(
  binary: Uint8Array,
  env: Float32Array,
  peak: Float32Array,
  rate: number,
): number {
  const runs = runsOf(binary);
  const spans: number[] = [];
  const limit = Math.max(4, Math.round(0.2 * rate));

  for (let r = 1; r < runs.length - 1; r++) {
    const m = runs[r]!;
    if (m.state !== 1) continue;

    const loIn = cross(env, peak, m.from, -1, EDGE_LO, false, limit);
    const hiIn = cross(env, peak, m.from, 1, EDGE_HI, true, limit);
    if (hiIn > loIn) spans.push((hiIn - loIn) / rate);

    const last = m.to - 1;
    const hiOut = cross(env, peak, last, -1, EDGE_HI, true, limit);
    const loOut = cross(env, peak, last, 1, EDGE_LO, false, limit);
    if (loOut > hiOut) spans.push((loOut - hiOut) / rate);
  }

  if (spans.length === 0) return 0;
  spans.sort((a, b) => a - b);
  return spans[spans.length >> 1]!;
}

/** How much of the correction to apply, from the measured edge rate.
 *
 * Zero at or below the instrument's own resolution, rising linearly to full
 * at twice that. Continuous, so a recording sitting near the floor cannot flip
 * between two different measurement rules and report two different speeds. */
export function correctionWeight(edgeSec: number): number {
  const floor = slowEdgeFloorSec();
  if (!(floor > 0)) return 0;
  const over = edgeSec / floor - 1;
  return Math.min(1, Math.max(0, over));
}

/** Segments with every boundary re-placed at half the local steady level.
 *
 * `weight` blends between the threshold crossing the segmenter found (0) and
 * the half-steady crossing (1). At 0 this returns exactly the boundaries
 * `runLengths` would have produced, so a signal that does not need correcting
 * is not correlated, not adjusted, and not touched.
 *
 * Boundaries are kept in order and never allowed to cross: a refined start
 * that reached back past the previous mark's refined end would produce a
 * negative gap, which is not a thing that can be graded. */
export function refineEdges(
  binary: Uint8Array,
  env: Float32Array,
  peak: Float32Array,
  rate: number,
  weight: number,
): Segment[] {
  const runs = runsOf(binary);
  const limit = Math.max(4, Math.round(0.2 * rate));
  const bounds: Array<[number, number]> = [];

  for (const m of runs) {
    if (m.state !== 1) continue;
    let start = m.from;
    let end = m.to;

    if (weight > 0) {
      // Whichever side of half-steady the threshold crossing landed on, walk
      // to the crossing itself.
      const sAbove = env[m.from]! >= MEASURE_AT * peak[m.from]!;
      const s = cross(env, peak, m.from, sAbove ? -1 : 1, MEASURE_AT, !sAbove, limit);
      const last = m.to - 1;
      const eAbove = env[last]! >= MEASURE_AT * peak[last]!;
      const e = cross(env, peak, last, eAbove ? 1 : -1, MEASURE_AT, !eAbove, limit);

      start = Math.round(m.from + weight * (s - m.from));
      end = Math.round(m.to + weight * (e + 1 - m.to));
    }

    const prev = bounds[bounds.length - 1];
    if (prev && start <= prev[1]) start = prev[1] + 1;
    if (end <= start) end = start + 1;
    if (start >= binary.length) break;
    bounds.push([start, Math.min(end, binary.length)]);
  }

  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of bounds) {
    if (start > at) out.push([0, (start - at) / rate]);
    out.push([1, (end - start) / rate]);
    at = end;
  }
  if (at < binary.length) out.push([0, (binary.length - at) / rate]);
  return out;
}
