/* Keeping what you are sending in view, in Plain mode.
 *
 * A message longer than the chart runs off its right edge, and scrolling means
 * a hand off the paddle. Paced mode moves the chart on the clock; Plain mode
 * has no clock to move it on. So it follows what has been sent: the live
 * decode Zen mode sees each character begin, and when the last one of a word
 * begins, the chart slides the next word to the left edge. Waiting until the
 * letter was read back left a lag after every word; this way the next word is
 * in view while the last letter is still being keyed. Ahead of the target
 * speed or behind it, the chart is where you are. Within a word wider than
 * the view, the letter being keyed is kept in view as well.
 *
 * The same reading marks the target's characters on the chart with Live
 * grading on, as Zen mode marks its message.
 *
 * A component that draws nothing, so the count it holds re-renders only this
 * and not the review behind it.
 */

import { useEffect, useMemo, useRef } from "react";
import type { Recorder } from "@/capture/mic";
import type { Timeline } from "@/types";
import { opensWord } from "@/timing/timeline";
import type { ChartHandle } from "./Chart";
import { useLiveProgress } from "./useLiveProgress";

export interface FollowSendingProps {
  readonly recorder: Recorder;
  readonly charWpm: number;
  readonly farnsworthWpm: number;
  /** The target the chart draws, every pass included. */
  readonly ideal: Timeline;
  readonly handle: ChartHandle;
  /** Follow: slide the chart along with the sending, and finish the take at
   *  the end of the message. */
  readonly follow: boolean;
  /** Live grading: mark the target's characters on the chart as they are
   *  keyed and read back. */
  readonly grade: boolean;
  /** The sender is done: every character read back, and the key up a while
   *  after the last. Called once per take, as Zen mode's is, with `follow`
   *  on. */
  onFinish(): void;
}

export function FollowSending({
  recorder,
  charWpm,
  farnsworthWpm,
  ideal,
  handle,
  follow,
  grade,
  onFinish,
}: FollowSendingProps): null {
  /* The characters the chart draws, so a count of them is an index into it. */
  const target = useMemo(() => ideal.chars.map((c) => c.char), [ideal]);
  const { reached, graded, done } = useLiveProgress(
    { recorder, charWpm, farnsworthWpm },
    target,
  );

  /* The end of the message: the take finishes itself, as it does in Zen mode
     with Live progress on. Once per take; a restart clears the reading, and
     that arms it again. `onFinish` is held in a ref because the screen behind
     rebuilds it on every render. */
  const finish = useRef(onFinish);
  finish.current = onFinish;
  const finished = useRef(false);
  useEffect(() => {
    if (graded.length === 0) finished.current = false;
    if (!follow || !done || finished.current) return;
    finished.current = true;
    finish.current();
  }, [follow, done, graded.length]);

  /* Live grading: the target's characters marked on the chart as they are
     begun and read back. Cleared when the take is over, where the review's
     own reading takes over. */
  useEffect(() => {
    handle.chart?.setLiveMarks(grade ? { chars: ideal.chars, reached, graded } : null);
  }, [grade, ideal, reached, graded, handle]);
  useEffect(() => () => handle.chart?.setLiveMarks(null), [handle]);

  /* The index of each word's first character, by the same rule the chart
     highlights words by: a word gap or a pause opens one. */
  const firsts = useMemo(
    () => ideal.chars.flatMap((c, i) => (i === 0 || opensWord(c) ? [i] : [])),
    [ideal],
  );

  /* Where the view starts: the first letter of the word after the latest one
     whose last letter has begun. `reached` counts the characters begun, and
     only rises within a take, so the view never slides back. Before any
     word's last letter, the first word, so a take begins with it in view
     wherever the chart was left; a restart puts it there again. The last
     word has no word after it, and beginning its last letter moves nothing. */
  let anchor = 0;
  for (let w = 0; w + 1 < firsts.length; w++) {
    const last = firsts[w + 1]! - 1;
    if (last < reached) anchor = firsts[w + 1]!;
    else break;
  }
  useEffect(() => {
    const ch = ideal.chars[anchor];
    if (follow && ch) handle.chart?.reveal(ch.t0, "tgt");
  }, [follow, anchor, ideal, handle]);

  /* Within a word, the character being keyed stays in view. A word wider than
     the view would otherwise run its later letters off the right edge, since
     the slide above waits for its last letter. A word that fits never moves
     the view here. The last letter of a word is the slide's, and it leaves
     that letter off to the left on purpose. */
  const at = reached - 1;
  const lastOfWord = firsts.includes(at + 1) && at + 1 < ideal.chars.length;
  useEffect(() => {
    const ch = ideal.chars[at];
    if (!follow || !ch || lastOfWord) return;
    handle.chart?.keepInView(ch.t0, ch.t1, "tgt");
  }, [follow, at, lastOfWord, ideal, handle]);

  /* The take is over, or following was turned off: the view goes back into
     its frame, so the review does not open on empty space past the end. */
  useEffect(() => {
    if (follow) return () => handle.chart?.endReveal();
    handle.chart?.endReveal();
    return undefined;
  }, [follow, handle]);

  return null;
}
