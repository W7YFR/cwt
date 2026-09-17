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

import { useEffect, useRef } from "react";
import { fmtElapsed } from "./format";
import { LevelMeter } from "./Record";

export interface ZenModeProps {
  /** The message being sent, already upper-cased by the session. */
  readonly message: string;
  /** The recorder's clock, read per frame while one is running. */
  readonly elapsed: () => number;
  /** Input level, 0 to 1. The one thing this sheet covers that cannot be
   *  replaced by a keystroke: with the page gone there is otherwise nothing to
   *  say the microphone is hearing anything, and a silent take is not
   *  discovered until it has been sent. */
  readonly level: number;
  /** Analyzing the take just stopped — the same state that bars the button. */
  readonly busy: boolean;
  onFinish(): void;
  onRestart(): void;
  onDiscard(): void;
}

export function ZenMode({
  message,
  elapsed,
  level,
  busy,
  onFinish,
  onRestart,
  onDiscard,
}: ZenModeProps): React.ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLSpanElement>(null);

  /* Focus the sheet itself, not a button. Enter finishes the take from
     anywhere — it is bound on the document so it works with a hand on the
     paddle — and a focused button would take the same key and fire twice. */
  useEffect(() => {
    box.current?.focus();
  }, []);

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
        <p className="zenmessage" data-testid="zen-message">
          {message || <span className="zennothing">No message set for this session</span>}
        </p>

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
