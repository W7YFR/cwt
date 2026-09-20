/* The first screen: record, or open a file.
 *
 * Recording is the primary path and gets the bigger half, because that is what
 * the tool is for — a decoder that only reads files is a curiosity, and a
 * trainer you can key into is a practice instrument. Opening a file is still
 * here because it is how you check a recording you already have.
 */

import { useCallback, useRef, useState } from "react";
import { ACCEPTED } from "@/capture/file";
import { MIC_SOURCE } from "@/io/take";
import { orderProfiles, type Profile } from "@/io/profiles";
import type { AudioClip } from "@/types";
import { fmtElapsed } from "./format";
import { DevicePicker, LevelMeter, RecDot } from "./Record";
import { Wordmark } from "./Wordmark";
import { visitWordmark } from "./wordmarks";
import { useRecorder } from "./useRecorder";
import { useUpperField } from "./useUpperField";
import { SoundPathHelp } from "./SoundPath";

export interface LandingProps {
  expected: string;
  onExpectedChange(text: string): void;
  onAudio(
    clip: AudioClip,
    source: string,
    fromMic: boolean,
    data: ArrayBuffer | null,
  ): void;
  /** Hand a picked file up to be opened. The drop half of this is answered
   *  page-wide rather than by this screen — see ui/useFileDrop.ts. */
  onFile(file: File): void;
  onError(message: string): void;
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
  /** Saved calibrations, and which one is being applied. */
  profiles: readonly Profile[];
  profileId: string | undefined;
  onProfileChange(id: string | undefined): void;
  onCalibrate(): void;
  /** Open the review with nothing recorded in it — see useTake.reset. */
  onPractice(): void;
}

/** The author's callsign, drawn — the same six rows the site at w7yfr.com
 *  puts at the top of its own front page.
 *
 *  Copied rather than shared: the two are separate repositories with no build
 *  between them, so there is no import that could carry it. Kept byte for byte
 *  all the same, because the point of it is that somebody arriving here from
 *  there recognises the mark as the same one.
 *
 *  Every row is the same width, which is what makes the block a rectangle and
 *  `--cols` honest — see wordmarks.ts, where the app's own drawings say the
 *  same thing at more length. */
const CALLSIGN_ART = `██╗    ██╗███████╗██╗   ██╗███████╗██████╗ 
██║    ██║╚════██║╚██╗ ██╔╝██╔════╝██╔══██╗
██║ █╗ ██║    ██╔╝ ╚████╔╝ █████╗  ██████╔╝
██║███╗██║   ██╔╝   ╚██╔╝  ██╔══╝  ██╔══██╗
╚███╔███╔╝   ██║     ██║   ██║     ██║  ██║
 ╚══╝╚══╝    ╚═╝     ╚═╝   ╚═╝     ╚═╝  ╚═╝`;

const CALLSIGN_ROWS = CALLSIGN_ART.split("\n").length;
const CALLSIGN_COLS = CALLSIGN_ART.split("\n")[0]!.length;

/** Out to the site this one hangs off.
 *
 * In the corner rather than in the flow, and the corner the settings button is
 * not in. What it points at is not part of the app — it is the place the app
 * lives — so it belongs at the edge of the page rather than among the three
 * ways in, which are what this screen is for.
 *
 * Only on the landing screen. Once a recording is on the page there is a
 * header with its own way home, and a second one two rows above it would be a
 * link out of a session somebody is in the middle of.
 *
 * Drawn at the same size and in the same ink as the name in the review
 * header, hover included, because at a glance they are the same kind of
 * thing: a small drawing of a name that takes you somewhere. */
function CallsignLink(): React.ReactElement {
  return (
    <a
      className="callsign"
      href="https://www.w7yfr.com"
      // The drawing carries the name for anyone who can see it; this is the
      // same name for anyone who cannot. The art itself is hidden, or a
      // screen reader reads six rows of box-drawing characters aloud.
      aria-label="W7YFR — back to w7yfr.com"
    >
      {/* The shape goes on the drawing, the way `Wordmark` and `Brandmark`
          both do it — the size calc reads it, and it is a fact about the art
          rather than about the link wrapped round it. */}
      <span
        className="art"
        aria-hidden="true"
        style={
          {
            "--cols": String(CALLSIGN_COLS),
            "--rows": String(CALLSIGN_ROWS),
          } as React.CSSProperties
        }
      >
        {CALLSIGN_ART}
      </span>
    </a>
  );
}

export function Landing(props: LandingProps): React.ReactElement {
  const fileInput = useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState(false);
  const { onAudio, onError } = props;
  const expected = useUpperField(props.onExpectedChange);

  const rec = useRecorder({
    deviceId: props.deviceId,
    onClip: useCallback(
      (clip: AudioClip) => onAudio(clip, MIC_SOURCE, true, null),
      [onAudio],
    ),
    onError,
    startKey: true,
  });

  if (rec.busy) {
    return (
      <div className="busy" role="status">
        measuring your sending…
      </div>
    );
  }

  return (
    <div className="landing">
      <CallsignLink />
      <Wordmark art={visitWordmark()} />

      <p className="lede">
        Key into your microphone and every dit, dah and gap gets measured against
        a perfect sender, <em>so you can become the perfect sender!</em>
      </p>

      <div className="intended-field">
        {/* The one question on this screen, asked like one. Skipped, the
            grading has only the decode to compare against — which is a
            meaningless 100% for accuracy — so it is worth a moment's
            attention rather than a line of small print. */}
        <label htmlFor="landing-expected">
          What are you going to send?
          <div className="hint">
            optional — but with it you get accuracy as well as timing
          </div>
        </label>
        <input
          id="landing-expected"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="CQ CQ DE W1AW K"
          value={props.expected}
          ref={expected.ref}
          onChange={expected.onChange}
        />
      </div>

      <div className="ways">
        <div className="way">
          <h2>Record</h2>
          {rec.recorder ? (
            <div className="recording">
              <div className="reclight">
                <span className="dot" />
                {fmtElapsed(rec.elapsed)}
              </div>
              <LevelMeter level={rec.level} />
              <div className="rowbuttons">
                <button className="big" onClick={() => void rec.finish()}>
                  Stop and review
                </button>
                <button onClick={rec.restart}>Start over</button>
              </div>
              <button className="link" onClick={() => void rec.discard()}>
                cancel
              </button>
              <p className="hint">
                Enter finishes the take · R starts over · Esc throws it away
              </p>
            </div>
          ) : rec.probing ? (
            /* Nothing, for the frame it takes to find out. Which control
               belongs here is read off the device list, and every default
               this could fall back to is a control that might be wrong — the
               one it used to fall back to was a working record button. */
            null
          ) : rec.blocked ? (
            /* Not a record button that cannot record.
               Nothing on this page can lift a block — the browser keeps that
               control for itself, deliberately — so a button here would be
               one that opens a prompt nobody is shown and fails silently.
               Saying what happened and where the switch is, is the only
               useful thing this card can do. */
            <p className="blocked" data-testid="mic-denied">
              Microphone access is blocked for this site, so there is nothing
              to record from. Allow it in your browser&rsquo;s settings for
              this page, then reload. You can still open a recording you
              already have.
            </p>
          ) : rec.needAccess ? (
            /* Asking is its own step, before anything is recorded.
               Until the browser has said yes it will not name the inputs, so
               the picker above correctly draws nothing and the only control
               on the screen is a record button — which then raises the prompt
               and, the moment it is granted, starts a take on whatever the
               default input happens to be. That is two decisions taken by one
               click, and the one it takes for you is the one this screen is
               here to let you make: which microphone. */
            <>
              <button
                className="big"
                data-testid="grant-mic"
                onClick={() => void rec.grantAccess()}
                title="Ask the browser for the microphone, so your inputs can be listed"
              >
                Grant Mic Access
              </button>
              <p className="hint">
                Your inputs cannot be listed until the browser has allowed it.
                Nothing is recorded by asking.
              </p>
            </>
          ) : (
            <>
              {/* Input first, then the button that uses it. Choosing what to
                  record from is a decision you make before recording, and a
                  picker under the button reads as an afterthought. */}
              <DevicePicker
                devices={rec.devices}
                value={props.deviceId}
                onChange={props.onDeviceChange}
              />
              <button
                className="big"
                onClick={() => void rec.start()}
                title="Start recording — or press R"
              >
                <RecDot /> Start recording
              </button>
              <CalibrationStatus
                profiles={props.profiles}
                value={props.profileId}
                deviceId={props.deviceId}
                onChange={props.onProfileChange}
                onCalibrate={props.onCalibrate}
                onHelp={() => setHelp(true)}
              />
            </>
          )}
        </div>

        <div className="way drop">
          <h2>Or open a recording</h2>
          <button className="big" onClick={() => fileInput.current?.click()}>
            Choose a file
          </button>
          {/* The button is the control; this is only the file dialog it
              opens. Left in the tab order it is a stop on nothing: focus
              lands on a clipped 1px box with no visible ring. */}
          <input
            ref={fileInput}
            className="visually-hidden"
            tabIndex={-1}
            type="file"
            accept={ACCEPTED}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) props.onFile(file);
              e.target.value = "";
            }}
          />
          <p>
            Or drop one anywhere on the page. WAV, MP3, M4A, FLAC and OGG all
            work. Files are read exactly as recorded — no calibration is applied
            to them.
          </p>
        </div>

        {/* Across both, because it is not a third way in — it is what the
            other two are for. Recording without hearing the target first, and
            without a cursor to keep time against, is keying blind; this is the
            door to the room where those live. */}
        <div className="way practice">
          <h2>Start Practicing</h2>
          <p>Enter the review area to practice drills and improve your timing.</p>
          {/* Never barred, even with nothing typed above. The target is built
              from the intended message and there is little to practice against
              without one — but the box for it is right there on the next
              screen, and a door that will not open is a worse way to say so
              than the room itself saying it. */}
          <button className="big" data-testid="practice" onClick={props.onPractice}>
            Let&rsquo;s go!
          </button>
        </div>
      </div>

      {/* Underneath, and small. It is a reassurance about how the thing works,
          not a reason to use it, and above the fold it was competing with the
          one sentence that says what the tool is for. */}
      <p className="privacy">
        Private by design. All analysis is performed right here in the browser.
      </p>

      {help && <SoundPathHelp onClose={() => setHelp(false)} />}
    </div>
  );
}

interface CalibrationStatusProps {
  profiles: readonly Profile[];
  value: string | undefined;
  deviceId: string | undefined;
  onChange(id: string | undefined): void;
  onCalibrate(): void;
  onHelp(): void;
}

/** Whether this microphone has been measured, and what to do about it.
 *
 * Stated rather than implied. Whether a calibration is being applied changes
 * every number the review then reports, by about the size of the room — so
 * "which one is in use" is not a setting to go looking for, it is a fact about
 * the recording you are one click from making, and it belongs on screen next
 * to the button that makes it.
 *
 * Every entry in the list carries its measurement, and that is not decoration:
 * the same microphone in two positions gives two profiles whose names are
 * equally plausible and whose numbers are nothing alike. "shack desk, 13 ms,
 * good" against "shack desk, 34 ms, unusable" is the difference between a
 * working session and a misleading one.
 *
 * No calibration is a legitimate and default answer, so this states the fact
 * and offers the button and stops there. What is between the keyer and this
 * app is unknown until it has been measured — it may be a room, and it may be
 * a virtual audio device with nothing in the path at all — so there is nothing
 * honest to say here about what calibration would find.
 */
function CalibrationStatus({
  profiles,
  value,
  deviceId,
  onChange,
  onCalibrate,
  onHelp,
}: CalibrationStatusProps): React.ReactElement {
  const ordered = orderProfiles(profiles, deviceId);
  const active = profiles.find((p) => p.id === value) ?? null;
  /* A profile measured on one input and applied to another is the specific
     mistake named profiles exist to prevent, so it is called out rather than
     left to be inferred from a name somebody chose months ago. */
  const elsewhere =
    active && deviceId && active.deviceId && active.deviceId !== deviceId;

  return (
    <div
      className={`calstatus ${active ? (elsewhere ? "warn" : "ok") : "none"}`}
      data-testid="calstatus"
      data-state={active ? (elsewhere ? "elsewhere" : "active") : "none"}
    >
      <p className="calstate" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        {active ? (
          <span>
            Calibrated · <b data-testid="calname">{active.nickname}</b>
            <span className="calnum" data-testid="calnum">
              {" "}
              {(active.releaseOffsetSec * 1000).toFixed(1)} ms · {active.verdict}
            </span>
          </span>
        ) : (
          <span>This microphone is not calibrated</span>
        )}
      </p>

      {elsewhere && (
        <p className="hint">
          “{active.nickname}” was measured on a different input. Pick another, or
          calibrate this one.
        </p>
      )}

      <div className="calactions">
        {ordered.length > 0 && (
          <select
            aria-label="Microphone calibration"
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value || undefined)}
          >
            <option value="">No calibration</option>
            {ordered.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nickname} — {(p.releaseOffsetSec * 1000).toFixed(1)} ms, {p.verdict}
              </option>
            ))}
          </select>
        )}
        {/* An ordinary border, like every other button. Wearing the accent at
            rest it had nowhere to go on hover — the color hover moves a border
            TO was the color it was already — so the one button on this panel
            was the one that did not answer the pointer. What marks it as the
            thing to do is the dot and the line above it, which say so in
            words. */}
        <button onClick={onCalibrate}>
          {active ? "Recalibrate" : "Calibrate this microphone"}
        </button>
      </div>

      {/* Under the calibration rather than beside the input picker. Calibrating
          is the point at which somebody first wonders what the app is actually
          listening through, and the answer is often that they should not be
          calibrating at all — a direct connection has nothing to measure. */}
      <button className="link calhelp" data-testid="sound-path-open" onClick={onHelp}>
        Need help?
      </button>
    </div>
  );
}
