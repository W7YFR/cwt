/* React's window onto the canvas.
 *
 * Deliberately thin. The chart is imperative — it repaints at sixty frames a
 * second while audio runs, and its scroll position and hover state have no
 * business going through a reducer. So this component creates the chart once,
 * hands it new data when the props change, and otherwise stays out of the way.
 *
 * The rule that keeps it honest: nothing in render/ imports React, and nothing
 * here reaches into the chart's internals. If that ever stops being true, the
 * canvas will start re-rendering on state it does not care about.
 */

import { Fragment, useEffect, useRef, useState } from "react";
import { createChart, type Chart, type ChartCallbacks } from "@/render/canvas";
import type { HitResult, Focus } from "@/render/focus";
import { HEIGHT } from "@/render/geometry";
import { CLASS_LONG } from "./copy";
import type { Review, ReviewSettings } from "@/types";

export interface ChartHandle {
  chart: Chart | null;
}

export interface ChartProps {
  review: Review;
  /** Every attempt in the session. Omitted when there is one thing to show. */
  stack?: readonly Review[];
  /** Session indices, in the order their rows go. */
  order?: readonly number[];
  selected?: number;
  /** The session number of `stack[0]`, when the stack is a tail of a session
   *  rather than all of it. */
  firstRun?: number;
  /** The track playback is about, for the gutter's highlight. */
  heard?: "you" | "tgt";
  settings: ReviewSettings;
  focus: Focus | null;
  playhead: { t: number; side: "you" | "tgt" } | null;
  /* Optional: a chart can be shown purely to be looked at. The calibration
     preview is one — it has no transport of its own, so a click that seeks
     nothing would be a control that lies. */
  onPlayChar?: ChartCallbacks["onPlayChar"];
  onSeek?: ChartCallbacks["onSeek"];
  onSelectRun?: ChartCallbacks["onSelectRun"];
  onSelectTarget?: ChartCallbacks["onSelectTarget"];
  onPlayTrack?: ChartCallbacks["onPlayTrack"];
  onZoom?: ChartCallbacks["onZoom"];
  /** The view moved. Used to keep more than one chart in step. */
  onScroll?: ChartCallbacks["onScroll"];
  /** Given the live chart so the parent can fit, export, or scroll it. */
  handle: ChartHandle;
}

/** A tooltip's content, as data rather than as markup.
 *
 * `char` is kept apart from the rest because it is the one piece that is not a
 * number we formatted. It comes from the morse table, and that table's prosigns
 * are written in angle brackets — `<AR>`, `<SK>`, `<SOS>`. Interpolated into a
 * string of HTML those parse as tags and the name silently disappears, which is
 * exactly what this tooltip used to do. Handed to React as a child it is text,
 * and React escapes it. */
interface TipContent {
  /** The character or prosign under the pointer. */
  char: string;
  /** What that element is graded as, when there is something to say. */
  note?: string;
  /** The measured figures, one to a line beneath the heading. */
  lines: string[];
}

interface Tip extends TipContent {
  x: number;
  y: number;
}

/** The character, for when the chart is drawing one tick per character.
 *
 * Led by when it started and how the gap before it came out, because that is
 * what a marker is about — naming the element under the pointer would describe
 * something that is not on screen, and would put the dit-and-dah count back in
 * front of somebody who turned it off. */
function tipForChar(hit: HitResult, unitSec: number): TipContent {
  const lines = [`starts at ${hit.char.t0.toFixed(2)}s`];
  const g = hit.char.leadGap;
  if (g && g.targetUnits > 0 && hit.row === "you") {
    const pct = (g.units / g.targetUnits - 1) * 100;
    lines.push(
      `gap before ${g.units.toFixed(2)}u — target ${g.targetUnits.toFixed(2)}u ` +
        `(${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`,
    );
  }
  let units = 0;
  for (const b of hit.char.blocks) units += b.units;
  lines.push(`runs ${(units * unitSec * 1000).toFixed(0)} ms`);
  return { char: hit.char.char, lines };
}

function tipFor(hit: HitResult, unitSec: number): TipContent {
  const b = hit.block;
  const ms = b.units * unitSec * 1000;
  // Name the class it is *graded* as, so the target figure below makes sense,
  // and say what the decoder actually read when the two disagree.
  const lines = [`${ms.toFixed(0)} ms / ${b.units.toFixed(2)}u`];
  if (b.targetUnits > 0 && hit.row === "you") {
    const pct = (b.units / b.targetUnits - 1) * 100;
    lines.push(
      `target ${b.targetUnits.toFixed(2)}u (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`,
    );
  }
  if (b.targetKind !== b.kind) lines.push(`read as ${CLASS_LONG[b.kind]}`);
  if (hit.row === "you") lines.push(`at ${b.t0.toFixed(2)}s`);
  return { char: hit.char.char, note: CLASS_LONG[b.targetKind], lines };
}

export function ChartView({
  review,
  stack,
  order,
  selected,
  firstRun,
  heard,
  settings,
  focus,
  playhead,
  onPlayChar,
  onSeek,
  onSelectRun,
  onSelectTarget,
  onPlayTrack,
  onZoom,
  onScroll,
  handle,
}: ChartProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  // Callbacks are held in a ref so the chart is created exactly once. Passing
  // them straight through would tear the canvas down and rebuild it on every
  // parent render, losing the scroll position each time.
  const cb = useRef({
    onPlayChar,
    onPlayTrack,
    onSeek,
    onSelectRun,
    onSelectTarget,
    onZoom,
    onScroll,
  });
  cb.current = {
    onPlayChar,
    onPlayTrack,
    onSeek,
    onSelectRun,
    onSelectTarget,
    onZoom,
    onScroll,
  };
  const unitRef = useRef(review.ref.unitSec);
  unitRef.current = review.ref.unitSec;
  const blocksRef = useRef(settings.charMarkers);
  blocksRef.current = settings.charMarkers;

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const chart = createChart(host, canvas, {
      onPlayChar: (...a) => cb.current.onPlayChar?.(...a),
      onSeek: (...a) => cb.current.onSeek?.(...a),
      onSelectRun: (...a) => cb.current.onSelectRun?.(...a),
      onSelectTarget: (...a) => cb.current.onSelectTarget?.(...a),
      onPlayTrack: (...a) => cb.current.onPlayTrack?.(...a),
      onZoom: (...a) => cb.current.onZoom?.(...a),
      onScroll: (...a) => cb.current.onScroll?.(...a),
      onHover: (hit, x, y) => {
        const content = hit
          ? blocksRef.current
            ? tipForChar(hit, unitRef.current)
            : tipFor(hit, unitRef.current)
          : null;
        setTip(content ? { ...content, x, y } : null);
      },
    });
    chartRef.current = chart;
    handle.chart = chart;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => chart.refreshTheme();
    mq.addEventListener("change", onTheme);
    window.addEventListener("resize", chart.resize);

    return () => {
      mq.removeEventListener("change", onTheme);
      window.removeEventListener("resize", chart.resize);
      chart.destroy();
      chartRef.current = null;
      handle.chart = null;
    };
  }, [handle]);

  useEffect(() => {
    chartRef.current?.update({
      review,
      settings,
      focus,
      ...(stack ? { stack } : {}),
      ...(order ? { order } : {}),
      ...(selected === undefined ? {} : { selected }),
      ...(firstRun ? { firstRun } : {}),
      ...(heard ? { heard } : {}),
    });
  }, [review, stack, order, selected, firstRun, heard, settings, focus]);

  useEffect(() => {
    chartRef.current?.setPlayhead(playhead);
  }, [playhead]);

  return (
    <>
      <div className="plot" ref={hostRef}>
        <canvas ref={canvasRef} height={HEIGHT} aria-label="Keying timing chart" />
      </div>
      {tip && (
        <div
          className="tip"
          role="tooltip"
          style={{
            left: Math.min(tip.x + 14, window.innerWidth - 288),
            top: tip.y + 16,
          }}
        >
          <b>{tip.char}</b>
          {tip.note ? ` — ${tip.note}` : null}
          {tip.lines.map((line, i) => (
            <Fragment key={i}>
              <br />
              {line}
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}
