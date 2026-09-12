/* The headline figures.
 *
 * Two scores and three facts, in that order. "Consistent" is the one that
 * matters for keying and it comes first; "accurate" only appears when there is
 * an intended message to be accurate against, because grading a decode against
 * itself is a meaningless 100%.
 */

import type { Review, ReviewSettings, Take } from "@/types";

function scoreClass(v: number, good: number, ok: number): string {
  return v >= good ? "ok" : v >= ok ? "warn" : "bad";
}

export interface ScoresProps {
  review: Review;
  settings: ReviewSettings;
  take: Take;
}

export function Scores({ review, settings, take }: ScoresProps): React.ReactElement {
  const g = review.analysis;
  const c = review.comparison;
  const m = take.measured;

  return (
    <div className="scores">
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
    </div>
  );
}
