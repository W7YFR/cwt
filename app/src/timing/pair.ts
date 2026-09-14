/* Pairing a decode against the intended message, character by character —
 * and then using the pairing to fix what the decoder could only guess at.
 */

import type { Char, EditOp, Slot, Timeline } from "@/types";
import { align } from "./align";

type Token = readonly [tok: string, char: Char | null];

/** Characters plus explicit word-boundary tokens.
 *
 * The same stream `compareText` aligns on, so the pairing and the accuracy
 * figure can never disagree about where the words were. */
function tokenStream(tl: Timeline): Token[] {
  const out: Token[] = [];
  for (const c of tl.chars) {
    const g = c.leadGap;
    if (g && (g.kind === "word-gap" || g.kind === "pause")) out.push([" ", null]);
    out.push([c.char, c]);
  }
  return out;
}

/** Align a decode against the intended message.
 *
 * Each space op is folded onto the character that follows it, so a
 * word-boundary error is visible twice: as the slot's `spaceOp`, and as that
 * slot's own gap being the wrong length. */
export function pair(actual: Timeline, ideal: Timeline): Slot[] {
  const aItems = tokenStream(actual);
  const bItems = tokenStream(ideal);
  const ops = align(
    bItems.map((x) => x[0]), // expected
    aItems.map((x) => x[0]), // got
  );

  const slots: Slot[] = [];
  let ai = 0;
  let bi = 0;
  let pendingSpace: EditOp | null = null;

  for (const step of ops) {
    let op: EditOp = step.op;
    let idealItem: Token | null = step.a !== null ? bItems[bi++] ?? null : null;
    let actualItem: Token | null = step.b !== null ? aItems[ai++] ?? null : null;

    // A space token carries no character; it only reports whether the word
    // boundary landed where it should, which hangs on the next character.
    if (idealItem && idealItem[1] === null) {
      pendingSpace = actualItem && actualItem[1] === null ? op : "del";
      idealItem = null;
    }
    if (actualItem && actualItem[1] === null) {
      if (pendingSpace === null) pendingSpace = "ins";
      actualItem = null;
    }
    if (idealItem === null && actualItem === null) continue;

    // A space aligned against a character leaves one side empty, so the
    // character's own verdict is no longer `op` — it's an extra or a miss.
    if (idealItem === null) op = "ins";
    else if (actualItem === null) op = "del";

    slots.push({
      op,
      actual: actualItem ? actualItem[1] : null,
      ideal: idealItem ? idealItem[1] : null,
      spaceOp: pendingSpace,
    });
    pendingSpace = null;
  }
  return slots;
}

/** Re-target each decoded gap from the intended message, in place.
 *
 * `buildTimeline` has to guess a gap's class from its duration, which is the
 * only information it has. Once the intended text is known that guess is
 * obsolete: if the alignment pairs a decoded character with an intended one,
 * the intended character's lead gap says what the silence before it was
 * *supposed* to be, whatever it measured. Without this, Farnsworth-ish letter
 * gaps that overshoot the target's char/word split get graded as word gaps and
 * average out to a flattering score, while the character-gap row vanishes from
 * the report entirely.
 *
 * Rests are the exception, deliberately. `buildTimeline` has already judged a
 * silence far past any spacing to be the sender stopping, and the intended
 * text cannot overrule that: practicing a list of separate words means the
 * text has a word gap at every point you paused between exercises, and grading
 * those as word gaps buries the real errors under 200-unit "deviations". Where
 * that line falls is `pauseFactor`'s job, not this one's.
 *
 * Only gaps move — a mis-decoded character says nothing reliable about what its
 * elements meant. And only `targetKind`/`targetUnits` move: `kind` must go on
 * reporting what the decoder read, because the decoded text, the word-boundary
 * diff, and `pair`'s own token stream are all derived from it. That is what
 * makes this safe to run after pairing; it cannot invalidate the pairing it
 * was handed.
 *
 * Returns how many gaps changed class. */
export function retarget(slots: readonly Slot[]): number {
  let moved = 0;
  for (const slot of slots) {
    if (!slot.actual || !slot.ideal) continue;
    const got = slot.actual.leadGap;
    const want = slot.ideal.leadGap;
    if (!got || !want || got.kind === "pause") continue;
    if (got.targetKind !== want.kind) moved++;
    got.targetKind = want.kind;
    got.targetUnits = want.targetUnits;
  }
  return moved;
}
