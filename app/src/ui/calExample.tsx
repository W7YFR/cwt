/* Real calibrations, one for each outcome the result screen has, for looking
 * at it without keying one. Dev server only: `?calexample` lists them, and
 * `?calexample=success`, `clean`, `noisy` or `failed` opens one.
 *
 * Never in a build. App.tsx reaches this module only through a dynamic import
 * inside `if (import.meta.env.DEV)`, which the build folds to `if (false)`, so
 * the module and the recordings it names are left out of the bundle.
 *
 * From the corpus, all keyed at 15 wpm. Its drills were recorded as separate
 * files, so each is trimmed to its keying and placed in its slot on the
 * wizard's own timeline, where the result screen's play buttons look for it.
 */

import { decodeAudioFile } from "@/dsp";
import { drillWindows } from "@/io/calibration";
import type { AudioClip } from "@/types";

/** The speed the corpus was keyed at. */
export const EXAMPLE_WPM = 15;

const DRILLS = ["dits", "dahs", "single-dits", "cq-de-w7yfr"] as const;
const k3ng = (k: string, src: string) => `test/data/k3ng/${k}/k3ng-${src}-${k}-15wpm.wav`;
const ft710 = (k: string, src: string) => `test/data/ft710/${k}/ft710-${k}-${src}-15wpm.wav`;

/** One recording per outcome, drill by drill. */
const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  // A webcam four feet from the speaker: marginal, with a usable correction.
  success: DRILLS.map((k) => k3ng(k, "webcam")),
  // The same keying on a direct line: nothing to correct.
  clean: DRILLS.map((k) => k3ng(k, "virtual")),
  // The direct line's dits against the webcam's dahs: the drills disagree.
  noisy: [k3ng("dits", "virtual"), k3ng("dahs", "webcam"), k3ng("single-dits", "virtual"), k3ng("cq-de-w7yfr", "virtual")],
  // A radio's sidetone across a room: the drills shatter and are refused.
  failed: DRILLS.map((k) => ft710(k, "webcam")),
};

/** What each example is, for the list. */
const LABELS: readonly { name: string; headline: string; what: string }[] = [
  { name: "success", headline: "Success!", what: "A webcam four feet from the speaker. Marginal, with a correction to save." },
  { name: "clean", headline: "Nothing to correct", what: "The same keying on a direct line in." },
  { name: "noisy", headline: "The drills didn't agree", what: "Line-in dits against webcam dahs." },
  { name: "failed", headline: "Let’s try that again…", what: "A radio's sidetone across a room. The drills come back too ragged to use." },
];

export function isCalExample(name: string): boolean {
  return name in EXAMPLES;
}

/** The list: one button for each example. */
export function CalExamplePicker(): React.ReactElement {
  return (
    <div className="settings">
      <div className="panel">
        <h2>Calibration examples</h2>
        <p className="lede">
          Dev server only. Each opens the calibration result on a real recording,
          keyed at {EXAMPLE_WPM} wpm. Nothing is kept unless you save it.
        </p>
        {LABELS.map((l) => (
          <section key={l.name} className="panelsec">
            {/* A reload rather than state: the URL is then one to come back
                to, and the example loads the way it would from a bookmark. */}
            <button
              className="calexample"
              // Inline, so not even a stylesheet rule ships for a dev tool.
              style={{ alignSelf: "flex-start" }}
              data-testid={`calexample-${l.name}`}
              onClick={() => {
                window.location.search = `?calexample=${l.name}`;
              }}
            >
              {l.headline}
            </button>
            <p className="lede">{l.what}</p>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Where the keying in a clip starts and ends, in samples. */
function keyedSpan(clip: AudioClip): [number, number] {
  let peak = 0;
  for (const v of clip.samples) peak = Math.max(peak, Math.abs(v));
  const floor = peak * 0.2;
  let first = 0;
  let last = clip.samples.length - 1;
  while (first < last && Math.abs(clip.samples[first]!) < floor) first++;
  while (last > first && Math.abs(clip.samples[last]!) < floor) last--;
  return [first, last + 1];
}

/** The drills as one take, each in its own slot on the wizard's timeline. */
export function spliceExample(parts: readonly AudioClip[]): AudioClip {
  const rate = parts[0]!.rate;
  const windows = drillWindows();
  const end = windows[windows.length - 1]!.toSec;
  const samples = new Float32Array(Math.round(end * rate));
  let peak = 0;
  parts.forEach((part, i) => {
    const w = windows[i]!;
    const [from, to] = keyedSpan(part);
    const room = Math.round((w.toSec - w.fromSec - 0.5) * rate);
    const body = part.samples.subarray(from, Math.min(to, from + room));
    samples.set(body, Math.round((w.fromSec + 0.25) * rate));
    peak = Math.max(peak, part.peak);
  });
  return { samples, rate, peak };
}

export async function loadCalExample(name: string): Promise<AudioClip> {
  const files = EXAMPLES[name] ?? EXAMPLES.success!;
  const parts = await Promise.all(
    files.map(async (f) => decodeAudioFile(await (await fetch(f)).arrayBuffer())),
  );
  return spliceExample(parts);
}
