/* The numbers under the chart: class averages, worst deviations, accuracy.
 *
 * The deviation table's values are play controls. Clicking yours and then the
 * target, back to back, is the single most useful thing in the app — a number
 * being 40% long does not tell you what to do differently, and hearing the two
 * does.
 */

import { diffRuns, subLabel } from "@/timing";
import { isBlankTake } from "@/io/take";
import { gradeOf, GRADE_MARK } from "@/render/scene";
import { slotIndexAtTime, type Focus } from "@/render/focus";
import type { Review } from "@/types";
import { CLASS_HELP, CLASS_LABEL, DEVIATION_NOTE, DEVIATION_SCOPE_NOTE } from "./copy";

export interface ReportProps {
  review: Review;
  tolerance: number;
  onPlayDeviation(side: "you" | "tgt", idx: number, kind: Focus["kind"]): void;
  onFocus(focus: Focus | null): void;
}

/** A class name you can hover for what the class means. Marked with a dotted
 *  underline, because a tooltip nobody knows is there explains nothing. */
function ClassCell({
  kind,
  extra,
}: {
  kind: keyof typeof CLASS_LABEL;
  extra?: string;
}): React.ReactElement {
  return (
    <td className="why" title={`${CLASS_LABEL[kind]} — ${CLASS_HELP[kind]}${extra ?? ""}`}>
      {CLASS_LABEL[kind]}
    </td>
  );
}

export function Report({
  review,
  tolerance,
  onPlayDeviation,
  onFocus,
}: ReportProps): React.ReactElement {
  const g = review.analysis;
  const c = review.comparison;

  /* Nothing to report on yet. Three cards of empty tables would say the same
     thing at far greater length, and an "every element landed inside
     tolerance" note over a grade with no elements in it would say something
     untrue. */
  if (isBlankTake(review.take)) {
    /* Two different nothings. With a message there is a target on screen to
       work against and the next move is to hear it; without one there is an
       empty chart, and saying "the target above is what you are about to
       send" would be pointing at nothing. */
    const hasTarget = review.ideal.chars.length > 0;
    return (
      <section className="report" data-testid="report">
        <div className="card">
          <h2>Nothing recorded yet</h2>
          <p
            className="note empty"
            data-testid="report-blank"
            data-target={String(hasTarget)}
          >
            {hasTarget ? (
              <>
                {/* No promise about where the grading turns up: this card is
                    the one part of the report that shows whether or not the
                    grading tables are switched on, so it cannot point at
                    something that may not be there. */}
                The target above is what you are about to send. Hear it with{" "}
                <b>Target</b>, set the speeds and the tolerance you want to be
                held to, then record.
              </>
            ) : (
              <>
                Say what you are going to send in <b>Intended message</b> above
                and the target appears, to hear and to key against. You can
                record without one — the timing still gets graded, against your
                own sending rather than against anything you meant.
              </>
            )}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="report" data-testid="report">
      <div className="card">
        <h2>Element &amp; spacing</h2>
        <table>
          <tbody>
            <tr>
              <th>class</th>
              <th>yours</th>
              <th>target</th>
              <th>jitter</th>
              <th>n</th>
              <th />
            </tr>
            {g.stats.map((s) => {
              const grade = gradeOf(s.meanUnits, s.targetUnits, tolerance);
              return (
                <tr key={s.name}>
                  <ClassCell kind={s.name} />
                  <td className={grade}>{s.meanUnits.toFixed(2)}u</td>
                  <td>{s.targetUnits.toFixed(2)}u</td>
                  <td>±{s.stdUnits.toFixed(2)}</td>
                  <td>{s.n}</td>
                  <td className={grade}>{GRADE_MARK[grade]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {g.nPauses > 0 && (
          <p className="note">
            {g.nPauses} long inter-transmission pause
            {g.nPauses === 1 ? "" : "s"} left out of the grading.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Where to focus next</h2>
        {g.deviations.length > 0 ? (
          <>
            <table>
              <tbody>
                <tr>
                  <th>at</th>
                  <th>class</th>
                  <th>yours</th>
                  <th>target</th>
                  <th>context</th>
                </tr>
                {g.deviations.map((d, i) => {
                  const idx = slotIndexAtTime(review.slots, d.timeSec);
                  const focus = (side: "you" | "tgt") => ({ side, idx, kind: d.kind });
                  return (
                    <tr key={`${d.timeSec}-${d.kind}-${i}`}>
                      <td>{d.timeSec.toFixed(2)}s</td>
                      <ClassCell kind={d.kind} extra={DEVIATION_NOTE} />
                      <td
                        className="bad play"
                        data-side="you"
                        title="hear yours"
                        onClick={() => onPlayDeviation("you", idx, d.kind)}
                        onMouseEnter={() => onFocus(focus("you"))}
                        onMouseLeave={() => onFocus(null)}
                      >
                        {d.valueUnits.toFixed(2)}u ▸
                      </td>
                      <td
                        className="play"
                        data-side="tgt"
                        title="hear the target"
                        onClick={() => onPlayDeviation("tgt", idx, d.kind)}
                        onMouseEnter={() => onFocus(focus("tgt"))}
                        onMouseLeave={() => onFocus(null)}
                      >
                        {d.targetUnits.toFixed(2)}u ▸
                      </td>
                      <td>{d.context ? `after ${d.context}` : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="note">{DEVIATION_SCOPE_NOTE}</p>
          </>
        ) : (
          <p className="note empty">
            Every element landed inside tolerance — that is clean sending. Try a
            tighter tolerance, or a higher speed, to find your next edge.
          </p>
        )}
      </div>

      {c && (
        <div className="card">
          <h2>Accuracy vs intended text</h2>
          {/* The two texts, before the arithmetic about them. The diff below
              shows where they parted company but never shows either one whole,
              and "3 sub · 1 extra" means very little until you can see what
              was asked for and what came back. */}
          <dl className="texts">
            <div>
              <dt>Intended</dt>
              <dd data-testid="intended-text">{c.expected}</dd>
            </div>
            <div>
              <dt>Decoded</dt>
              <dd data-testid="decoded-text">{c.decoded}</dd>
            </div>
            {/* In the same list as the two texts, so it is labeled like them
                and lines up under them. An unlabeled row of counts reads as a
                footnote to the diff below rather than as the summary of the
                two lines above. */}
            <div>
              <dt>Differences</dt>
              <dd className="plain" data-testid="difference-counts">
                {c.substitutions} sub · {c.insertions} extra · {c.deletions} missed,
                out of {c.nExpected} symbols
              </dd>
            </div>
          </dl>
          <p className="diff">
            {diffRuns(c.ops).map((run, i) => {
              if (run.op === "equal") {
                return (
                  <span className="eq" key={i}>
                    {run.expected}
                  </span>
                );
              }
              const text =
                run.op === "sub"
                  ? `[${subLabel(run.expected, run.got)}]`
                  : run.op === "del"
                    ? `[-${run.expected}]`
                    : `[+${run.got}]`;
              return (
                <span className="er" key={i}>
                  {text}
                </span>
              );
            })}
          </p>
        </div>
      )}
    </section>
  );
}
