/* The first screen: the front door.
 *
 * One thing to do here, and it is the first thing under the introduction:
 * start practicing. Under it, small, is the one setup fact worth seeing on the
 * way in: which microphone, and whether it is calibrated. Calibrating means
 * nothing without knowing which input it is for, so the two sit together.
 * Recording and the intended message are on the practice screen only.
 *
 * Shown to a first visit only. A returning visitor opens straight onto the
 * review screen — see LANDING_VERSION.
 */

import { useEffect, useRef, useState } from "react";
import { isDevBuild } from "@/build-info";
import { ACCEPTED } from "@/capture/file";
import type { Profile } from "@/io/profiles";
import { DevicePicker } from "./Record";
import { SoundPathHelp } from "./SoundPath";
import { useRecorder, type RecorderHandle } from "./useRecorder";
import { Wordmark } from "./Wordmark";
import { visitWordmark } from "./wordmarks";

/** Which landing screen a visitor last passed through.
 *
 * Raise it to show the landing screen once more to everyone who has seen an
 * older one: a visitor whose stored number is lower than this gets it again on
 * their next visit, and passes it from then on. */
export const LANDING_VERSION = 1;

export interface LandingProps {
  /** Open the review with nothing recorded in it — see useTake.reset. */
  onPractice(): void;
  /** Hand a picked file up to be opened. The drop half of this is answered
   *  page-wide rather than by this screen — see ui/useFileDrop.ts. */
  onFile(file: File): void;
  onError(message: string): void;
  /** The input the next recording uses. */
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
  /** Saved calibrations, and which one is being applied. */
  profiles: readonly Profile[];
  profileId: string | undefined;
  onCalibrate(): void;
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

/** This screen lists the inputs and never records from them. */
const NO_CLIP = (): void => {};

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
 * thing: a small drawing of a name that takes you somewhere.
 *
 * Except on the dev server, where it goes nowhere. It sits in the corner a
 * thumb reaches for, and following it means leaving the thing being worked on
 * — on a phone that is a browser navigating off the LAN to the public site,
 * and the way back is retyping an address with a port in it. The drawing
 * stays, because its other job is being part of the screen being looked at. */
function CallsignLink(): React.ReactElement {
  const art = (
    /* The shape goes on the drawing, the way `Wordmark` and `Brandmark` both
       do it — the size calc reads it, and it is a fact about the art rather
       than about whatever is wrapped round it. */
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
  );

  if (isDevBuild()) {
    /* Not a disabled link: a dead `<a>` is still a link to a keyboard and to
       a screen reader, announced as somewhere to go and then going nowhere.
       Without the href it is what it looks like — a drawing — and the name is
       still said, because the art itself cannot say it. */
    return (
      <span className="callsign" role="img" aria-label="W7YFR" data-dev="true">
        {art}
      </span>
    );
  }

  return (
    <a
      className="callsign"
      href="https://www.w7yfr.com"
      // The drawing carries the name for anyone who can see it; this is the
      // same name for anyone who cannot. The art itself is hidden, or a
      // screen reader reads six rows of box-drawing characters aloud.
      aria-label="W7YFR — back to w7yfr.com"
    >
      {art}
    </a>
  );
}

export function Landing(props: LandingProps): React.ReactElement {
  const fileInput = useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState(false);
  const { onPractice } = props;
  /* For the device list and the permission behind it, which the recorder
     already reads the way every other screen needs them read. Nothing here
     starts a take: no record key, and no button that calls `start`. */
  const rec = useRecorder({
    deviceId: props.deviceId,
    onClip: NO_CLIP,
    onError: props.onError,
  });

  /* Enter starts, from anywhere that is not already a control. A focused
     button or link has its own Enter, and taking it from them would make the
     key do something other than what the focus ring says. */
  useEffect(() => {
    if (help) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Enter" || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const at = document.activeElement;
      if (at && at !== document.body) return;
      e.preventDefault();
      onPractice();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [help, onPractice]);

  return (
    <div className="landing">
      <CallsignLink />
      <Wordmark art={visitWordmark()} />

      <p className="lede">
        Key into your microphone and every dit, dah and gap gets measured against
        a perfect sender, <em>so you can become the perfect sender!</em>
      </p>

      {/* The one large control on the screen, straight under the sentence
          that says what it is for. */}
      <button
        className="big primary start"
        data-testid="practice"
        onClick={onPractice}
        title="Start practicing — or press Enter"
      >
        Start practicing
      </button>

      <MicSetup
        rec={rec}
        deviceId={props.deviceId}
        onDeviceChange={props.onDeviceChange}
        profiles={props.profiles}
        value={props.profileId}
        onCalibrate={props.onCalibrate}
        onHelp={() => setHelp(true)}
      />

      {/* A link rather than a card. A recording you already have is the rare
          way in, and a drop works anywhere on the page without it. */}
      <button className="link openfile" onClick={() => fileInput.current?.click()}>
        or open a recording
      </button>
      {/* The button is the control; this is only the file dialog it opens.
          Left in the tab order it is a stop on nothing: focus lands on a
          clipped 1px box with no visible ring. */}
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

      {/* Underneath, and small. It is a reassurance about how the thing works,
          not a reason to use it. */}
      <p className="privacy">
        Private by design. All analysis is performed right here in the browser.
      </p>

      {help && <SoundPathHelp onClose={() => setHelp(false)} />}
    </div>
  );
}

interface MicSetupProps {
  rec: RecorderHandle;
  onDeviceChange(id: string | undefined): void;
  profiles: readonly Profile[];
  value: string | undefined;
  deviceId: string | undefined;
  onCalibrate(): void;
  onHelp(): void;
}

/** Which microphone, and whether it has been measured.
 *
 * Stated rather than implied, because a calibration changes every number the
 * review reports, and it is only true of the input it was measured on. Small,
 * because it is a fact to check on the way in rather than the way in itself.
 * Choosing among saved calibrations is in the settings.
 */
function MicSetup({
  rec,
  onDeviceChange,
  profiles,
  value,
  deviceId,
  onCalibrate,
  onHelp,
}: MicSetupProps): React.ReactElement {
  const active = profiles.find((p) => p.id === value) ?? null;
  /* A profile measured on one input and applied to another is the specific
     mistake named profiles exist to prevent, so it is called out rather than
     left to be inferred from a name somebody chose months ago. */
  const elsewhere = Boolean(
    active && deviceId && active.deviceId && active.deviceId !== deviceId,
  );
  const state = active ? (elsewhere ? "elsewhere" : "active") : "none";

  return (
    <div
      className={`calline ${active ? (elsewhere ? "warn" : "ok") : "none"}`}
      data-testid="calstatus"
      data-state={state}
    >
      <MicChoice rec={rec} deviceId={deviceId} onDeviceChange={onDeviceChange} />
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
          <span>Not calibrated</span>
        )}
        <span aria-hidden="true">·</span>
        <button className="link" onClick={onCalibrate}>
          {active ? "Recalibrate" : "Calibrate"}
        </button>
        <span aria-hidden="true">·</span>
        <button className="link" data-testid="sound-path-open" onClick={onHelp}>
          Need help?
        </button>
      </p>
      {elsewhere && (
        <p className="hint">
          “{active!.nickname}” was measured on a different input.
        </p>
      )}
    </div>
  );
}

/** The input the next take records from: a picker where there is a choice,
 *  its name where there is not, and a way to ask where the browser has not
 *  said yet. */
function MicChoice({
  rec,
  deviceId,
  onDeviceChange,
}: {
  rec: RecorderHandle;
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
}): React.ReactElement | null {
  // Nothing for the frame it takes to find out.
  if (rec.probing) return null;
  if (rec.blocked) {
    /* Not a control: nothing on the page can lift a block. The banner at the
       top of the app, or the error from the refused prompt, says where the
       switch is. */
    return (
      <p className="micblocked" data-testid="mic-denied">
        Microphone access is blocked for this site
      </p>
    );
  }
  if (rec.needAccess) {
    /* Asking is its own step. Until the browser says yes it will not name
       the inputs, and there is nothing to choose between. */
    return (
      <button
        className="link"
        data-testid="grant-mic"
        onClick={() => void rec.grantAccess()}
        title="Ask the browser for the microphone, so your inputs can be listed. Nothing is recorded by asking."
      >
        Allow the microphone to choose an input
      </button>
    );
  }
  if (rec.devices.length === 0) return null;
  if (rec.devices.length === 1) {
    return (
      <p className="micname" data-testid="mic-name">
        {rec.devices[0]!.label}
      </p>
    );
  }
  return <DevicePicker devices={rec.devices} value={deviceId} onChange={onDeviceChange} />;
}
