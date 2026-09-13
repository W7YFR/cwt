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

import { useEffect, useRef, useState } from "react";
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
  settings: ReviewSettings;
  focus: Focus | null;
  playhead: { t: number; side: "you" | "tgt" } | null;
  /* Optional: a chart can be shown purely to be looked at. The calibration
     preview is one — it has no transport of its own, so a click that seeks
     nothing would be a control that lies. */
  onPlayChar?: ChartCallbacks["onPlayChar"];
  onSeek?: ChartCallbacks["onSeek"];
  onZoom?: ChartCallbacks["onZoom"];
  /** Given the live chart so the parent can fit, export, or scroll it. */
  handle: ChartHandle;
}

interface Tip {
  html: string;
  x: number;
  y: number;
}

function tipFor(hit: HitResult, unitSec: number): string {
  const b = hit.block;
  const ms = b.units * unitSec * 1000;
  // Name the class it is *graded* as, so the target figure below makes sense,
  // and say what the decoder actually read when the two disagree.
  const lines = [
    `<b>${hit.char.char}</b> — ${CLASS_LONG[b.targetKind]}`,
    `${ms.toFixed(0)} ms / ${b.units.toFixed(2)}u`,
  ];
  if (b.targetUnits > 0 && hit.row === "you") {
    const pct = (b.units / b.targetUnits - 1) * 100;
    lines.push(
      `target ${b.targetUnits.toFixed(2)}u (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`,
    );
  }
  if (b.targetKind !== b.kind) lines.push(`read as ${CLASS_LONG[b.kind]}`);
  if (hit.row === "you") lines.push(`at ${b.t0.toFixed(2)}s`);
  return lines.join("<br>");
}

export function ChartView({
  review,
  settings,
  focus,
  playhead,
  onPlayChar,
  onSeek,
  onZoom,
  handle,
}: ChartProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  // Callbacks are held in a ref so the chart is created exactly once. Passing
  // them straight through would tear the canvas down and rebuild it on every
  // parent render, losing the scroll position each time.
  const cb = useRef({ onPlayChar, onSeek, onZoom });
  cb.current = { onPlayChar, onSeek, onZoom };
  const unitRef = useRef(review.ref.unitSec);
  unitRef.current = review.ref.unitSec;

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const chart = createChart(host, canvas, {
      onPlayChar: (...a) => cb.current.onPlayChar?.(...a),
      onSeek: (...a) => cb.current.onSeek?.(...a),
      onZoom: (...a) => cb.current.onZoom?.(...a),
      onHover: (hit, x, y) => {
        setTip(hit ? { html: tipFor(hit, unitRef.current), x, y } : null);
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
    chartRef.current?.update({ review, settings, focus });
  }, [review, settings, focus]);

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
          // The tooltip is assembled from measured numbers and a character the
          // decoder produced, never from anything a user typed.
          dangerouslySetInnerHTML={{ __html: tip.html }}
        />
      )}
    </>
  );
}
