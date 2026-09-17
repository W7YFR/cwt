/* The headline figures.
 *
 * Two scores and a handful of facts, in that order and on two lines. The
 * scores lead: "consistent" is the one that matters for keying, and "accurate"
 * only appears when there is an intended message to be accurate against,
 * because grading a decode against itself is a meaningless 100%. What is under
 * them is what they were measured from — the speeds, the length, the tone, the
 * level — which you go looking for rather than read at a glance.
 */

import type { Review, ReviewSettings, Take } from "@/types";
import { ACCURATE_BANDS, CONSISTENT_BANDS, scoreBand } from "@/timing";
import { fmtSeconds } from "./format";
import { isBlankTake } from "@/io/take";

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

  const runName = runOf && runOf.of > 1 && (
    /* Which attempt these figures are about.
       Everything in this band, and every table under it, is one run — and with
       a stack on the chart which one was only findable by noticing where the
       caption band had moved to. Named the way the chart names it, and in the
       color the chart lights it, so the row and its numbers are one thing.
       Absent with a single attempt, where there is nothing for it to be
       distinguished from. */
    <div className="score runname" data-testid="run-name">
      <b>Run {runOf.at + 1}</b>
    </div>
  );

  const drop = onDrop && runOf && runOf.of > 1 && (
    /* At the end of the head row: it is an action rather than a reading, and
       it throws a recording away. Only where there is a rest of the session to
       keep — with one attempt on screen, dropping it and clearing are the same
       act. */
    <button
      className="iconbtn droprun"
      onClick={onDrop}
      data-testid="drop-run"
      aria-label={`Drop run ${runOf.at + 1}`}
      title={`Throw run ${runOf.at + 1} away and keep the others`}
    >
      {/* Drawn rather than typed: no system font carries a trash can that can
          be relied on to look like one, and the emoji that do are a different
          color and weight from everything around them. Which run it will throw
          away moves to the name, where a screen reader finds it and a pointer
          finds it as a tooltip. */}
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path
          d="M2.5 4.5h11M6.5 4.5V3a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8v1.5M4 4.5l.7 8.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4.5M6.6 7v4M9.4 7v4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  /* Two rows rather than one that wraps.
   *
   * The band holds two grades and five measurements, and on a narrow window
   * the whole lot reflowed into whatever fitted — so which line a figure was
   * on was a fact about the window rather than about the figure, and the one
   * button among them ended up alone on a line of its own. Split, the head is
   * always the same three things and the way out of the run, and everything
   * that supports them is under it. Each row still wraps within itself, which
   * is the only wrapping left that tells you nothing. */
  if (isBlankTake(take)) {
    return (
      <div className="scores" data-testid="scores" data-blank="true">
        <div className="scorehead">
          {runName}
          <div className="score none">
            <b>—</b>
            <span>consistent</span>
          </div>
          <div className="score none">
            <b>—</b>
            <span>accurate</span>
          </div>
        </div>

        <div className="scoredetail">
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
      </div>
    );
  }

  return (
    <div className="scores" data-testid="scores" data-blank="false">
      <div className="scorehead">
        {runName}

        <div className={`score ${scoreBand(g.withinTolFrac, CONSISTENT_BANDS)}`}>
          <b>{Math.round(g.withinTolFrac * 100)}%</b>
          <span>consistent</span>
        </div>

        {c && (
          <div className={`score ${scoreBand(c.accuracy, ACCURATE_BANDS)}`}>
            <b>{(c.accuracy * 100).toFixed(1)}%</b>
            <span>accurate</span>
          </div>
        )}

        {drop}
      </div>

      <div className="scoredetail">
        <div className="score">
          <b>{m.charWpm.toFixed(1)}</b>
          <span>wpm sent (target {Math.round(settings.charWpm)})</span>
        </div>

        <div className="score">
          <b>{m.farnsworthWpm.toFixed(1)}</b>
          <span>wpm overall (target {Math.round(settings.farnsworthWpm)})</span>
        </div>

        {/* How long the message takes at the speeds now set, against how long
            it took. Both figures move when the speed sliders do, because the
            target is rendered from them — so this says "your sending runs
            eleven seconds where the target runs nine", which is the same fact
            as the speed readings above and far easier to feel. */}
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
            locked onto and the frequency the target track is synthesized at,
            so a wrong reading here explains a bad decode. */}
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
      </div>
    </div>
  );
}
