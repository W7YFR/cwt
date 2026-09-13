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

import { useEffect, useMemo, useRef, useState } from "react";
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
}

function build(
  clip: AudioClip,
  run: CalibrationRun,
  expected: string,
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
        profile: p,
      });
      /* Both charts are graded at the same target speed — the raw one's — so
         the difference between them is the correction and not a change of
         yardstick underneath it. */
      const settings: ReviewSettings = { ...defaultSettings(take), view: "per-char" };
      return { key, label, review: reviewTake(take, settings), settings };
    } catch {
      // Nothing readable in this section. The rest of the result still stands.
      return null;
    }
  };

  const raw = one("raw", "As recorded", null);
  if (!raw) return [];
  if (!profile) return [raw];

  const cal = one("calibrated", "With this calibration", profile);
  if (!cal) return [raw];
  // Graded against the same target as the raw one, so the two are comparable.
  const settings = { ...cal.settings, charWpm: raw.settings.charWpm, farnsworthWpm: raw.settings.farnsworthWpm };
  return [raw, { ...cal, settings, review: reviewTake(cal.review.take, settings) }];
}

function One({ variant }: { variant: Variant }): React.ReactElement {
  const handle = useRef<ChartHandle>({ chart: null }).current;
  const [ppu, setPpu] = useState(variant.settings.ppu);

  // Opened filled to the width, like the review does, and once: the preview
  // is not somewhere anybody pans around.
  useEffect(() => {
    const fitted = handle.chart?.fit();
    if (fitted !== undefined) setPpu(fitted);
  }, [handle, variant.review]);

  return (
    <div className="calchart" data-testid="calchart" data-variant={variant.key}>
      <span className="uplabel">{variant.label}</span>
      <ChartView
        review={variant.review}
        settings={{ ...variant.settings, ppu }}
        focus={null}
        playhead={null}
        handle={handle}
        onZoom={setPpu}
      />
    </div>
  );
}

export function CalPreview(props: CalPreviewProps): React.ReactElement | null {
  const variants = useMemo(
    () => build(props.clip, props.run, props.expected),
    [props.clip, props.expected, props.run],
  );
  if (variants.length === 0) return null;
  return (
    <div className="calpreview" data-testid="calpreview">
      {variants.map((v) => (
        <One key={v.key} variant={v} />
      ))}
    </div>
  );
}
