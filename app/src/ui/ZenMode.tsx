/* The message, alone, while you send it.
 *
 * Everything else this app puts on screen is about a recording that is already
 * over. While one is running, the chart behind it is a row of marks you cannot
 * read at speed and the scores are last time's — so the screen is busy with
 * nothing you can use, and the one thing you do need is a line of text in type
 * too small to glance at.
 *
 * This is not another practice aid. The paced ones put a beat in front of you
 * and ask you to meet it; this takes everything away and asks nothing, which
 * is why the two cannot run together.
 *
 * Elapsed time is written straight to the element rather than held in state.
 * It changes ten times a second and this sheet is over the whole screen; a
 * re-render of the review behind it, per tick, to move one digit, is the
 * spending the rest of the recording path already declines.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { CHAR_TO_MORSE, SYMBOL_RE } from "@/morse";
import { passCount } from "@/timing";
import { fmtElapsed } from "./format";
import { LevelMeter } from "./Record";
import { useLiveProgress, type LiveSource } from "./useLiveProgress";

/** The type never goes below this, however many passes are asked for: past it
 *  the sheet stops being something you can read at a glance, which is the only
 *  thing it is for. Under that it scrolls, which is the better failure. */
const MIN_PX = 16;
const MAX_PX = 104;

export interface ZenModeProps {
  /** The message being sent, already upper-cased by the session. One
   *  instance, as everywhere else it is read. */
  readonly message: string;
  /** How many passes of it make up this take.
   *
   * Drawn as that many lines rather than as one repeated string: what is on
   * screen is what you are about to send, and run together you cannot see
   * where one pass ends and the next begins — which is the one thing about a
   * repeat you need to be able to see. */
  readonly times: number;
  /** The recorder's clock, read per frame while one is running. */
  readonly elapsed: () => number;
  /** Input level, 0 to 1. The one thing this sheet covers that cannot be
   *  replaced by a keystroke: with the page gone there is otherwise nothing to
   *  say the microphone is hearing anything, and a silent take is not
   *  discovered until it has been sent. */
  readonly level: number;
  /** Analyzing the take just stopped — the same state that bars the button. */
  readonly busy: boolean;
  /** Where to follow the take from, with **Live progress** on. Each character
   *  of the message changes color as it starts to be keyed, and the take
   *  finishes itself once the last one has been read. Absent, the message
   *  stays one color and the take runs until it is stopped. */
  readonly live?: LiveSource | null | undefined;
  onFinish(): void;
  onRestart(): void;
  onDiscard(): void;
}

export function ZenMode({
  message,
  times,
  elapsed,
  level,
  busy,
  live = null,
  onFinish,
  onRestart,
  onDiscard,
}: ZenModeProps): React.ReactElement {
  /* One entry per pass, counted by the same function the target's own repeat
     counts with — so the sheet and the audio cannot disagree about how many
     there are. */
  const passes = Array.from({ length: passCount(times) }, (_, i) => i);

  /* Each pass as the parts it is drawn in. A part that can be keyed carries
     its place in the whole take, counted across passes, which is what the
     live count is a count of. Spaces and breaks carry none. */
  const parts = useMemo(() => {
    const one = message.match(SYMBOL_RE) ?? [];
    let at = 0;
    return passes.map(() =>
      one.map((text) => ({ text, at: text in CHAR_TO_MORSE ? at++ : -1 })),
    );
    // `passes` is rebuilt every render; its length is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, passes.length]);
  const target = useMemo(
    () => parts.flatMap((pass) => pass.filter((p) => p.at >= 0).map((p) => p.text)),
    [parts],
  );
  const { reached, graded } = useLiveProgress(live, target);

  /* The end of the message, read back: every character of every pass has a
     verdict, so the key has been up for a character gap after the last one.
     There is nothing left to send, and nothing left to wait for.

     Once per take. A restart clears the verdicts, and that arms it again.
     `onFinish` is held in a ref because the screen behind rebuilds it on
     every render. */
  const finish = useRef(onFinish);
  finish.current = onFinish;
  const finished = useRef(false);
  const ended = live !== null && target.length > 0 && graded.length >= target.length;
  useEffect(() => {
    if (graded.length === 0) finished.current = false;
    if (!ended || finished.current) return;
    finished.current = true;
    finish.current();
  }, [ended, graded.length]);
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);

  /* Focus the sheet itself, not a button. Enter finishes the take from
     anywhere — it is bound on the document so it works with a hand on the
     paddle — and a focused button would take the same key and fire twice. */
  useEffect(() => {
    box.current?.focus();
  }, []);

  /* Type as large as fits, found by measuring rather than by arithmetic.
   *
   * Three things decide whether it fits — how many passes, how long the
   * message is, and how wide the window is — and only the first two are
   * knowable in CSS. Every formula tried against the real thing failed
   * somewhere: the message wraps at a width that depends on the font the
   * browser actually picked, and a wrapped pass is two lines where the
   * arithmetic counted one. So this asks the box.
   *
   * A binary search over the size, eight steps, on open and on resize. Not per
   * frame and not while you send: nothing here changes once the sheet is up.
   */
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;

    const fit = () => {
      let low = MIN_PX;
      let high = MAX_PX;
      for (let step = 0; step < 8; step++) {
        const mid = (low + high) / 2;
        el.style.fontSize = `${mid}px`;
        // Vertical only: wrapping is allowed, and a wrapped pass shows up here
        // as the extra height it costs.
        if (el.scrollHeight <= el.clientHeight) low = mid;
        else high = mid;
      }
      el.style.fontSize = `${low}px`;
    };

    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [message, times]);

  useEffect(() => {
    let raf = 0;
    let shown = "";
    const tick = () => {
      const now = fmtElapsed(elapsed());
      if (now !== shown) {
        shown = now;
        if (clock.current) clock.current.textContent = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [elapsed]);

  return (
    <div className="sheet zensheet">
      <div
        className="zen"
        role="dialog"
        aria-modal="true"
        aria-label="Recording"
        data-testid="zen"
        tabIndex={-1}
        ref={box}
      >
        {/* No key handler of its own. Enter, R and Escape are bound on the
            document by the recorder, so they answer here exactly as they do
            behind this sheet — which is the point: your hand is on a paddle,
            not on this dialog. */}
        {/* Sized to fit — see the effect above. */}
        <div
          className="zenmessage"
          data-testid="zen-message"
          ref={text}
        >
          {message ? (
            parts.map((pass, at) => (
              <p className="zenpass" key={at}>
                {live
                  ? pass.map((p, i) =>
                      p.at < 0 ? (
                        p.text
                      ) : (
                        <span key={i} className={p.at < reached ? "zenkeyed" : undefined}>
                          {p.text}
                        </span>
                      ),
                    )
                  : message}
              </p>
            ))
          ) : (
            <p className="zennothing">No message set for this session</p>
          )}
        </div>

        <div className="zenfoot">
          {/* No waiting/sending states on this one: there is no count-in in
              Zen mode, so the light is only ever recording. */}
          <span className="reclight" data-testid="zen-clock">
            <span className="dot" />
            <span ref={clock}>{fmtElapsed(0)}</span>
          </span>
          <LevelMeter level={level} />

          {/* Every control the record bar behind this sheet was offering,
              because this covers it. Cancel included: Escape throws a take
              away and a key with no button is a way out only for somebody who
              already knows it is there. */}
          <div className="zenbuttons">
            <button className="primary" data-testid="zen-stop" disabled={busy} onClick={onFinish}>
              Stop and review
            </button>
            <button data-testid="zen-restart" onClick={onRestart}>
              Restart
            </button>
            <button data-testid="zen-cancel" onClick={onDiscard}>
              Cancel
            </button>
          </div>

          <span className="hint">enter to finish · r to restart · esc to cancel</span>
        </div>
      </div>
    </div>
  );
}
