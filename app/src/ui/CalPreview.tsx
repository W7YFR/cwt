/* What the calibration did, drawn.
 *
 * The readback is one line of text: it says the message came back as
 * "CQ DE W7YFR" and stops. That answers whether the decode is right and says
 * nothing about the thing a calibration is actually for, which is whether the
 * *lengths* are right. Two charts of the same ten seconds — once as recorded,
 * once through the profile just measured — is the only place in the app where
 * what a calibration does to a recording can be seen rather than taken on
 * trust.
 *
 * Its own module for a reason beyond tidiness: it is a canvas, and a canvas is
 * not renderable under jsdom. The wizard's end-to-end test drives everything
 * else on this screen, so the seam has to be here, where that test can stub it
 * and the browser tier can exercise the real thing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeClip } from "@/io/take";
import type { Profile } from "@/io/profiles";
import type { CalibrationRun } from "@/io/calibration";
import { defaultSettings, reviewTake } from "@/timing";
import type { AudioClip, Review, ReviewSettings } from "@/types";
import { ChartView, type ChartHandle } from "./Chart";

export interface CalPreviewProps {
  clip: AudioClip;
  run: CalibrationRun;
  /** What the operator says they sent, so the target is theirs rather than a
   *  rendering of our own decode. Empty is normal and fine. */
  expected: string;
  /** The speed the keyer was stated to be set to.
   *
   * Both charts are graded against this and not against either recording's own
   * measured speed, and that is the whole difference between a comparison and
   * a rigged one. `defaultSettings` takes its target from the take, and for a
   * take with no stated speed that target IS the speed the estimator measured
   * off it — so a recording graded that way is being compared against itself
   * and comes out flawless whatever is wrong with it. Grade the raw one that
   * way and it is perfect by construction, every correction can only move away
   * from perfect, and the chart says calibration makes things worse no matter
   * what the calibration does.
   *
   * The stated speed is the one reference here that comes from outside the
   * audio. It is also the reference the whole calibration rests on: the offset
   * is fitted so the held drills come out one and three units at this speed.
   * The marks are therefore fitted to it and prove little — but the GAPS are
   * not fitted to anything. Whether they land on 1, 3 and 7 units after the
   * correction hands them back what it took off the marks is an honest test,
   * and it is the one worth watching on these two charts. */
  wpm: number;
}

/** The profile the measurement would be saved as, before it has a name.
 *
 * A throwaway: the preview needs a `Profile` because that is what the decoding
 * path takes, and the only part of one that reaches the DSP is the
 * calibration inside it. */
function provisional(run: CalibrationRun): Profile | null {
  const c = run.calibration;
  if (!c || !run.usable) return null;
  return {
    id: "preview",
    nickname: "this calibration",
    wpm: c.wpm,
    releaseOffsetSec: c.releaseOffsetSec,
    spreadSec: c.spreadSec,
    elements: c.elements,
    verdict: run.quality.verdict,
    decaySec: run.quality.decaySec,
    maxWpm: run.quality.maxWpm,
    recordedAt: "",
  };
}

interface Variant {
  readonly key: "raw" | "calibrated";
  readonly label: string;
  readonly review: Review;
  readonly settings: ReviewSettings;
  /** What the estimator read off this version, for the caption. The single
   *  most legible number on the screen: one of these two is closer to the
   *  speed the keyer was set to, and that is what the calibration is for. */
  readonly charWpm: number;
}

function build(
  clip: AudioClip,
  run: CalibrationRun,
  expected: string,
  wpm: number,
): Variant[] {
  const mixed = run.sections.filter((s) => s.kind === "mixed");
  const message = mixed.length > 0 ? mixed[mixed.length - 1] : null;
  if (!message) return [];

  const part: AudioClip = {
    samples: clip.samples.subarray(message.from, message.to),
    rate: clip.rate,
    peak: clip.peak,
  };
  const text = expected.trim();
  const profile = provisional(run);

  const one = (key: Variant["key"], label: string, p: Profile | null) => {
    try {
      const { take } = analyzeClip(part, {
        source: "calibration",
        expected: text || null,
        expectedSource: text ? "what you said you'd send" : null,
        // Already a section of a longer recording; trimming it again would
        // move the times relative to the other variant and make the two
        // charts impossible to read against each other.
        trim: false,
        id: `preview-${key}`,
        now: "1970-01-01T00:00:00+00:00",
        // The external yardstick. See the note on `wpm` above — without it
        // each chart is graded against itself and the comparison is worthless.
        targetWpm: wpm,
        targetFarnsworth: wpm,
        profile: p,
      });
      const settings: ReviewSettings = { ...defaultSettings(take), view: "per-char" };
      return {
        key,
        label,
        review: reviewTake(take, settings),
        settings,
        charWpm: take.measured.charWpm,
      };
    } catch {
      // Nothing readable in this section. The rest of the result still stands.
      return null;
    }
  };

  const raw = one("raw", "As recorded", null);
  if (!raw) return [];
  if (!profile) return [raw];
  const cal = one("calibrated", "With this calibration", profile);
  return cal ? [raw, cal] : [raw];
}

function One({
  variant,
  wpm,
  ppu,
  handle,
  onZoom,
  onScroll,
}: {
  variant: Variant;
  wpm: number;
  ppu: number;
  handle: ChartHandle;
  onZoom(ppu: number): void;
  onScroll(x: number): void;
}): React.ReactElement {
  return (
    <div
      className="calchart"
      data-testid="calchart"
      data-variant={variant.key}
      // The speed this chart is graded against, so a test can check it is the
      // stated one and not the recording's own. That distinction is the whole
      // difference between a comparison and a rigged one.
      data-target={variant.review.ref.charWpm.toFixed(2)}
      data-reads={variant.charWpm.toFixed(2)}
    >
      <span className="uplabel">
        {variant.label}
        <b data-testid="calchart-wpm" data-wpm={variant.charWpm.toFixed(2)}>
          {" "}
          reads {variant.charWpm.toFixed(1)} wpm
        </b>
        <span className="hint"> · keyed at {wpm}</span>
      </span>
      <ChartView
        review={variant.review}
        settings={{ ...variant.settings, ppu }}
        focus={null}
        playhead={null}
        handle={handle}
        onZoom={onZoom}
        onScroll={onScroll}
      />
    </div>
  );
}

export function CalPreview(props: CalPreviewProps): React.ReactElement | null {
  const variants = useMemo(
    () => build(props.clip, props.run, props.expected, props.wpm),
    [props.clip, props.expected, props.run, props.wpm],
  );

  /* The two charts move as one.
   *
   * Reading one against the other is the entire point of showing both, and two
   * charts of the same ten seconds at different zooms and different scroll
   * positions is two charts of nothing in particular. So the zoom is one piece
   * of state shared between them, and a gesture on either is relayed to the
   * other.
   *
   * Pixels rather than seconds, deliberately. Both are laid out per character
   * from the same message, so the same scroll puts the same character under
   * the same point of the screen — which is the alignment somebody comparing
   * them is actually using. Matching by time would drift them apart by exactly
   * the correction being examined. */
  const handles = useRef<Record<string, ChartHandle>>({});
  const scrollX = useRef(0);
  const [ppu, setPpu] = useState<number | null>(null);
  /* Where the pair is scrolled to, written straight onto the wrapper rather
     than held in state. The scroll is imperative for the same reason it is
     imperative in the chart — it moves with the pointer, and routing it
     through a re-render of two canvases would make dragging stutter. This is
     the one readable trace of it. */
  const wrap = useRef<HTMLDivElement>(null);

  const handleFor = useCallback((key: string): ChartHandle => {
    return (handles.current[key] ??= { chart: null });
  }, []);

  const relay = useCallback((from: string, x: number) => {
    scrollX.current = x;
    wrap.current?.setAttribute("data-scroll", String(Math.round(x)));
    for (const [key, h] of Object.entries(handles.current)) {
      if (key !== from) h.chart?.scrollTo(x);
    }
  }, []);

  /* Opened filled to the width, and fitted once from whichever chart is there
     — they hold the same recording graded at the same speed, so one fit serves
     both and fitting them separately would start them disagreeing. */
  useEffect(() => {
    if (variants.length === 0) return;
    const first = handles.current[variants[0]!.key]?.chart;
    const fitted = first?.fit();
    if (fitted !== undefined) setPpu(fitted);
  }, [variants]);

  /* A zoom re-lays both charts out, and the one that was not touched keeps a
     scroll position measured against the old layout. Put it back after the
     new one has been built. */
  useEffect(() => {
    for (const h of Object.values(handles.current)) h.chart?.scrollTo(scrollX.current);
  }, [ppu]);

  if (variants.length === 0) return null;
  const zoom = ppu ?? variants[0]!.settings.ppu;

  return (
    <div
      className="calpreview"
      data-testid="calpreview"
      ref={wrap}
      data-ppu={zoom.toFixed(1)}
    >
      {variants.map((v) => (
        <One
          key={v.key}
          variant={v}
          wpm={props.wpm}
          ppu={zoom}
          handle={handleFor(v.key)}
          onZoom={setPpu}
          onScroll={(x) => relay(v.key, x)}
        />
      ))}
      <p className="hint">
        Both are measured against {props.wpm} wpm — the speed you said the keyer
        was set to.<br />Watch the gaps: the correction is fitted to the marks, so
        only the gaps are an independent test of it.
      </p>
    </div>
  );
}
