/* The headline figures.
 *
 * Two scores and three facts, in that order. "Consistent" is the one that
 * matters for keying and it comes first; "accurate" only appears when there is
 * an intended message to be accurate against, because grading a decode against
 * itself is a meaningless 100%.
 */

import type { Review, ReviewSettings, Take } from "@/types";
import { fmtSeconds } from "./format";
import { isBlankTake } from "@/io/take";

function scoreClass(v: number, good: number, ok: number): string {
  return v >= good ? "ok" : v >= ok ? "warn" : "bad";
}

export interface ScoresProps {
  review: Review;
  settings: ReviewSettings;
  take: Take;
  /** Throw this attempt away, when there are others to keep.
   *
   * Here rather than up with the record controls because this band IS the
   * attempt being read — the consistency, the accuracy, the speed it came out
   * at. Deciding to drop a run is something you do while looking at its
   * numbers, so the control belongs where the numbers are. */
  onDrop?: (() => void) | undefined;
  /** Which attempt these figures are, counted the way the chart counts. */
  runOf?: { at: number; of: number } | undefined;
}

export function Scores({
  review,
  settings,
  take,
  onDrop,
  runOf,
}: ScoresProps): React.ReactElement {
  const g = review.analysis;
  const c = review.comparison;
  const m = take.measured;

  /* Nothing recorded yet.
   *
   * Every figure here is a reading off a recording, and with no recording they
   * would all be lies of the most convincing kind — "100% consistent" out of
   * an empty grade, a speed that is really just the target read back. So the
   * readings are dashed and only the two facts that are genuinely known
   * without sending anything are given: what the target is set to, and how
   * long it runs. */
  if (isBlankTake(take)) {
    return (
      <div className="scores" data-testid="scores" data-blank="true">
        <div className="score none">
          <b>—</b>
          <span>consistent</span>
        </div>
        <div className="score none">
          <b>—</b>
          <span>accurate</span>
        </div>
        <div className="score none">
          <b>—</b>
          <span>wpm sent (target {Math.round(settings.charWpm)})</span>
        </div>
        <div className="score none">
          <b>—</b>
          <span>wpm overall (target {Math.round(settings.farnsworthWpm)})</span>
        </div>
        {review.ideal.duration > 0 && (
          <div className="score none">
            <b>—</b>
            <span>
              duration (target <output data-testid="target-duration">
                {fmtSeconds(review.ideal.duration)}
              </output>)
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="scores" data-testid="scores" data-blank="false">
      <div className={`score ${scoreClass(g.withinTolFrac, 0.9, 0.75)}`}>
        <b>{Math.round(g.withinTolFrac * 100)}%</b>
        <span>consistent</span>
      </div>

      {c && (
        <div className={`score ${scoreClass(c.accuracy, 0.95, 0.85)}`}>
          <b>{(c.accuracy * 100).toFixed(1)}%</b>
          <span>accurate</span>
        </div>
      )}

      <div className="score">
        <b>{m.charWpm.toFixed(1)}</b>
        <span>wpm sent (target {Math.round(settings.charWpm)})</span>
      </div>

      <div className="score">
        <b>{m.farnsworthWpm.toFixed(1)}</b>
        <span>wpm overall (target {Math.round(settings.farnsworthWpm)})</span>
      </div>

      {/* How long the message takes at the speeds now set, against how long it
          took. Both figures move when the speed sliders do, because the target
          is rendered from them — so this says "your sending runs eleven
          seconds where the target runs nine", which is the same fact as the
          speed readings above and far easier to feel. */}
      {review.ideal.duration > 0 && (
        <div className="score">
          <b data-testid="take-duration">{fmtSeconds(take.durationSec)}</b>
          <span>
            duration (target <output data-testid="target-duration">
              {fmtSeconds(review.ideal.duration)}
            </output>)
          </span>
        </div>
      )}

      {/* The detected tone. Worth showing plainly: it is what the decoder
          locked onto and the frequency the target track is synthesized at, so
          a wrong reading here explains a bad decode. */}
      <div className="score">
        <b>{Math.round(take.toneHz)}</b>
        <span>Hz tone (target matches)</span>
      </div>

      {take.peak > 0 && (
        <div className="score">
          <b>{(20 * Math.log10(take.peak)).toFixed(1)}</b>
          <span>
            dBFS peak · {(take.rate / 1000).toFixed(take.rate % 1000 ? 1 : 0)} kHz
          </span>
        </div>
      )}

      {/* Last, and pushed to the far end: it is an action rather than a
          reading, and it throws a recording away. Only when there is a rest of
          the session to keep — with one attempt on screen, dropping it and
          clearing are the same act. */}
      {onDrop && runOf && runOf.of > 1 && (
        <button
          className="droprun"
          onClick={onDrop}
          data-testid="drop-run"
          title="Throw this attempt away and keep the others"
        >
          Drop run {runOf.at + 1}
        </button>
      )}
    </div>
  );
}
