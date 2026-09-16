/* What order the attempts are drawn in.
 *
 * A session accumulates in the order it was recorded, and that is one useful
 * order among several: the latest attempt first is what you want while you are
 * still going, and the best or the worst first is what you want when you are
 * looking for the one that went right or the one that went wrong.
 *
 * Sorting changes where a row is drawn and nothing else. In particular it does
 * not change what a row is CALLED — a run's number is the order it was
 * recorded in, so the third attempt is RUN 3 wherever it lands. Renumbering by
 * position would make the chart disagree with itself the moment the order
 * changed: the row you were reading would take another attempt's name, and the
 * Drop button would offer to throw away a different recording than the one it
 * named.
 *
 * React- and canvas-free, so the ordering can be checked directly rather than
 * by drawing a chart and looking at it.
 */

import type { Review, ReviewSettings, RunSort } from "@/types";

export type { RunSort };

export const RUN_SORTS: readonly { value: RunSort; label: string }[] = [
  { value: "oldest", label: "Oldest first" },
  { value: "newest", label: "Newest first" },
  { value: "best", label: "Most consistent" },
  { value: "worst", label: "Least consistent" },
];

/** How many of the most recent attempts to draw, or null for all of them.
 *
 * A count rather than a flag because there are three answers now and there is
 * nothing special about one: the window is always a tail of the session, and
 * how long a tail is the only thing that varies. */
export function recentCount(show: ReviewSettings["showRuns"]): number | null {
  switch (show) {
    case "last":
      return 1;
    case "last5":
      return 5;
    case "all":
      return null;
  }
}

/** How good an attempt was, as one number.
 *
 * Consistency rather than accuracy, deliberately. Accuracy is about the text —
 * whether the right letters came out — and it is a fine thing to know, but it
 * is not what "a good run" means when the question is your keying: you can
 * send every character correctly and still be all over the place, and the
 * whole app exists to say so. It is also the score the review leads with. */
function quality(review: Review): number {
  return review.analysis.withinTolFrac;
}

/** Session indices, in the order their rows should be drawn.
 *
 * Indices rather than reordered reviews, so that every index the rest of the
 * app holds — which attempt is selected, which to drop — keeps meaning the
 * same attempt however the rows are arranged. */
export function runOrder(reviews: readonly Review[], sort: RunSort): number[] {
  const at = reviews.map((_, i) => i);
  switch (sort) {
    case "oldest":
      return at;
    case "newest":
      return at.reverse();
    /* Ties keep their recording order, which is what a stable sort over an
       already-ordered list gives — so two identical attempts do not swap
       places on a redraw. */
    case "best":
      return at.sort((a, b) => quality(reviews[b]!) - quality(reviews[a]!));
    case "worst":
      return at.sort((a, b) => quality(reviews[a]!) - quality(reviews[b]!));
  }
}
