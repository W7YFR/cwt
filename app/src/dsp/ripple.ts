/* Dips that are not gaps.
 *
 * A room does not deliver a mark at one steady level. Reflections arrive a few
 * milliseconds behind the direct sound and add to it or cancel it depending on
 * frequency and path length, so the envelope of a single held mark ripples. If
 * a trough of that ripple happens to cross the threshold, the mark is cut in
 * two, and everything downstream treats the pieces as separate elements. That
 * is why a reverberant recording decodes as a stream of E and T rather than as
 * whatever was sent: not because the timing was misread, but because one dah
 * became four dits.
 *
 * Duration cannot sort this out. The shards are milliseconds long, but so is a
 * dit at high speed, and the decoder has no way to know the speed before it has
 * segmented — which is the thing being got wrong. Depth can. A key-up that
 * really happened falls all the way to the noise floor, far below a threshold
 * that sits roughly halfway between noise and mark. A ripple trough only just
 * grazes under it and comes straight back. Measured on real recordings the two
 * populations do not overlap at all: genuine gaps bottom out at a hundredth of
 * the threshold, ripple troughs at nine tenths of it.
 *
 * So the only test is depth, and it is deliberately the only one. Pairing it
 * with "and the dip is shorter than the marks either side" reads as prudent —
 * two independent reasons before touching anything — but it fails on exactly
 * the case that needs help most. A thoroughly shattered mark is a row of
 * slivers, and a dip is not shorter than a four-millisecond sliver, so the
 * conjunction refuses to repair the worst damage while happily repairing the
 * mild. Depth alone has no such blind spot.
 *
 * On a recording with no ripple there are no shallow dips to find, so this does
 * nothing whatsoever — which is what keeps clean audio decoding exactly as it
 * did.
 */

/** How far below the threshold the envelope must fall for a gap to be real.
 *
 * Half. The threshold already sits between the noise floor and the mark level,
 * so a genuine key-up passes through this on its way down and keeps going,
 * while a trough that turns around above it never stopped being a mark. */
export const SHALLOW_FRAC = 0.5;

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

/** Most passes a badly shattered mark should need to reassemble. */
const MAX_PASSES = 12;

/** One pass: close every dip the depth test currently condemns.
 *
 * Decisions are taken from the runs as they stand and applied afterwards, so
 * filling one dip cannot change whether its neighbor qualifies within the same
 * pass — the result does not depend on which end the scan started from. */
function fillOnce(
  binary: Uint8Array,
  env: Float32Array,
  curve: Float64Array,
  shallowFrac: number,
): { out: Uint8Array; filled: number } {
  const runs = runsOf(binary);
  const out = Uint8Array.from(binary);
  let filled = 0;

  for (let r = 1; r < runs.length - 1; r++) {
    const gap = runs[r]!;
    if (gap.state !== 0) continue;

    // Bounded by marks on both sides. A dip at the very start or end of the
    // recording has no mark behind it and is just the recording beginning.
    const before = runs[r - 1]!;
    const after = runs[r + 1]!;
    if (before.state !== 1 || after.state !== 1) continue;

    let deepest = Infinity;
    for (let i = gap.from; i < gap.to; i++) {
      const t = curve[i]!;
      if (!(t > 0)) continue;
      const ratio = env[i]! / t;
      if (ratio < deepest) deepest = ratio;
    }
    if (deepest <= shallowFrac) continue;

    for (let i = gap.from; i < gap.to; i++) out[i] = 1;
    filled++;
  }

  return { out, filled };
}

/** Close key-up runs that are ripple troughs rather than gaps.
 *
 * Repeated to a fixed point. Closing a dip joins the marks either side of it,
 * which can leave a new dip adjacent to the joined mark that was not there to
 * be judged before. Every pass only ever turns key-up into key-down, so this
 * is monotone and settles.
 *
 * Returns a new array; the input is not modified. */
export function fillRippleGaps(
  binary: Uint8Array,
  env: Float32Array,
  curve: Float64Array,
  shallowFrac = SHALLOW_FRAC,
): Uint8Array {
  let current = binary;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const { out, filled } = fillOnce(current, env, curve, shallowFrac);
    if (filled === 0) return pass === 0 ? Uint8Array.from(binary) : current;
    current = out;
  }
  return current;
}
