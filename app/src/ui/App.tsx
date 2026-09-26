/* Three screens and the state between them. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadAudioFile } from "@/capture/file";
import { NoKeyingError, isBlankTake } from "@/io/take";
import {
  activeProfile,
  loadProfiles,
  profileForSource,
  selectProfile,
  type Profile,
} from "@/io/profiles";
import {
  loadPrefs,
  recallSelected,
  recallSession,
  recallTake,
  savePrefs,
} from "@/io/storage";
import type { AudioClip } from "@/types";
import { APP_VERSION } from "@/build-info";
import { Calibrate } from "./Calibrate";
import { Landing } from "./Landing";
import { Settings } from "./Settings";
import { ReviewScreen } from "./ReviewScreen";
import { useFileDrop } from "./useFileDrop";
import { OPEN_FILE_CLOSED } from "./copy";
import { useMicAccess } from "./useMicAccess";
import { useTake } from "./useTake";

/** How long the boot may take before it says anything.
 *
 * Long enough that an ordinary reload never reaches it, short enough that a
 * genuinely slow one does not look broken. */
export const BOOT_MESSAGE_DELAY_MS = 400;

export function App(): React.ReactElement {
  const take = useTake();
  const micAccess = useMicAccess();
  const [error, setError] = useState<string | null>(null);
  /* What kind of thing the banner is reporting, beside the sentence itself.
     The sentence is for a person and is expected to be reworded; this is what
     anything else branches on or asserts against. */
  const [errorKind, setErrorKind] = useState<string>("failed");
  const [intended, setIntended] = useState(() => loadPrefs().expected ?? "");
  const [deviceId, setDeviceId] = useState<string | undefined>(
    () => loadPrefs().deviceId,
  );
  /* The boot gate. Something has to hold the page while the checks below run,
     or the landing screen paints and is then replaced by a review — which is
     the flash this exists to prevent.

     Holding it is not the same as narrating it. The work is a 404 for a bundle
     that is usually not there and one IndexedDB read, which together take a
     few tens of milliseconds; a message on screen for that long is not
     information, it is a glitch on every single reload. So the gate is silent
     until the wait is long enough to be worth explaining — a slow network, or
     a large recording coming back off disk. */
  const [booting, setBooting] = useState(true);
  const [slowBoot, setSlowBoot] = useState(false);
  const [opening, setOpening] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [configuring, setConfiguring] = useState(false);

  /* Which calibration is being applied, held here because it changes what the
     decoder does to every recording that follows. `null` is the default and a
     real answer: until somebody calibrates, audio is read exactly as it was
     read before any of this existed. */
  const [profiles, setProfiles] = useState<Profile[]>(() => loadProfiles());
  const [profileId, setProfileId] = useState<string | undefined>(
    () => activeProfile()?.id,
  );
  const profile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profileId, profiles],
  );

  const chooseProfile = useCallback((id: string | undefined) => {
    selectProfile(id);
    setProfileId(id);
  }, []);

  /* Where a session comes from on the way in.
     1. The session you were in the middle of, out of IndexedDB. A reload must
        not drop recordings you just spent a minute keying.
     2. Nothing, which is the ordinary first visit and not an error. */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        /* A whole session, when there was one: several attempts at one
           message are what you were in the middle of, and coming back to the
           last of them alone would look like the others had been thrown
           away. */
        const session = await recallSession();
        if (!live) return;
        if (session.length) {
          const entries = await Promise.all(
            session.map(async (e) => ({
              take: e.take,
              audio: await e.audio.arrayBuffer(),
              settings: e.settings,
            })),
          );
          if (!live) return;
          take.adoptSession(entries, recallSelected());
          return;
        }

        /* One take, for a review that was left before sessions existed. The
           ordering is what is new; the takes themselves are stored the way
           they always were, so an old one still opens. */
        const saved = await recallTake();
        if (!live || !saved) return;
        take.adopt(saved.take, await saved.audio.arrayBuffer(), {
          settings: saved.settings,
          // It came from storage; writing it straight back would copy a few
          // megabytes of audio on every page load for no gain.
          remember: false,
        });
      } catch (e: unknown) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live) setBooting(false);
      }
    })();
    return () => {
      live = false;
    };
    // Once, on mount. `take` is stable enough for this and re-running would
    // reload the bundle over whatever the user has since recorded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!booting) return;
    const timer = window.setTimeout(() => setSlowBoot(true), BOOT_MESSAGE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [booting]);

  /* Which of the screens is on the page.
   *
   * The same chain the render ends in, named once so something other than JSX
   * can ask. Changing screens is this app's whole navigation — there is no
   * router and no URL to change — so it is also the only place a "page" can be
   * said to have been arrived at. */
  const screen = opening
    ? "opening"
    : booting && !take.loaded
      ? "booting"
      : configuring
        ? "settings"
        : calibrating
          ? "calibrate"
          : take.loaded && take.review
            ? "review"
            : "landing";

  /* Arriving at a screen means arriving at the top of it.
   *
   * A browser scrolls to the top when a page is replaced; nothing replaces a
   * page here, so the scroll position of the screen being left is simply still
   * in force on the one arriving. Recording from halfway down the landing
   * screen therefore opened the review halfway down the review — which, on a
   * screen whose first rows are the chart everything else refers to, reads as
   * having landed somewhere in the middle of something.
   *
   * `scrollingElement` rather than `window.scrollTo`: the body is the scroller
   * here, this is a property rather than a call, and it is the one form that
   * does not log its way through a jsdom that has no layout to scroll. */
  useEffect(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    scroller.scrollTop = 0;
  }, [screen]);

  const chooseDevice = useCallback((id: string | undefined) => {
    setDeviceId(id);
    const next = { ...loadPrefs() };
    if (id) next.deviceId = id;
    else delete next.deviceId;
    savePrefs(next);
  }, []);

  /* The intended message outlives the take, because practicing the same text
     until it comes out clean is the whole loop this tool exists for. */
  const chooseIntended = useCallback((text: string) => {
    setIntended(text);
    savePrefs({ ...loadPrefs(), expected: text });
  }, []);

  const onAudio = useCallback(
    (clip: AudioClip, source: string, fromMic: boolean, data: ArrayBuffer | null) => {
      setError(null);
      try {
        take.load(
          clip,
          {
            source,
            expected: intended || null,
            expectedSource: intended ? "what you said you'd send" : null,
            // A microphone take always opens and closes with a moment of dead
            // air while you reach for the mouse; a file is however the person
            // who made it left it, and trimming it would move their clock.
            trim: fromMic,
            // And for much the same reason a file is never corrected — see
            // profileForSource.
            profile: profileForSource(profile, fromMic),
          },
          data,
        );
      } catch (e) {
        /* Nothing keyed is its own answer, and already a complete sentence.
           Telling somebody to make sure there is CW in it, when the whole
           message is that there is none, reads as though the tool did not
           understand what it just said. */
        if (e instanceof NoKeyingError) {
          setErrorKind("no-keying");
          setError(
            `${e.message} Check that the tone is reaching the input you picked, ` +
              "and that your microphone can hear it.",
          );
          return;
        }
        setErrorKind("failed");
        setError(
          e instanceof Error
            ? `${e.message} — make sure the recording has some CW in it, then give it another go.`
            : String(e),
        );
      }
    },
    [intended, profile, take],
  );

  /* Opening a file lives here rather than on the landing screen, because a
     drop is answered anywhere on the page and the review is a page too: having
     looked at one recording, dragging the next one on is the obvious move. */
  const openFile = useCallback(
    async (file: File) => {
      setOpening(true);
      setError(null);
      try {
        const loaded = await loadAudioFile(file);
        onAudio(loaded.clip, loaded.name, false, loaded.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setOpening(false);
      }
    },
    [onAudio],
  );

  /* A file carries its own speed, and only the attempt that starts a session
     gets to set one — so a file can begin a session but never join one. The
     button beside Record says that when it is closed; a drop just does
     nothing, rather than putting an error in front of somebody for a gesture
     they can simply repeat after clearing. */
  const canOpenFile = !take.loaded || isBlankTake(take.loaded.take);

  const dropping = useFileDrop({
    onFile: (file) => {
      if (canOpenFile) void openFile(file);
    },
    onError: setError,
    disabled: opening,
  });

  return (
    <div className="app">
      {dropping && (
        /* The invitation says which of the two it is. Letting it read "drop a
           recording to open it" and then quietly doing nothing is the worse
           half of both options: it promises, and then it looks broken. */
        <div
          className={`dropveil ${canOpenFile ? "" : "closed"}`}
          role="presentation"
          data-accepts={String(canOpenFile)}
        >
          <p>{canOpenFile ? "Drop a recording to open it" : OPEN_FILE_CLOSED}</p>
        </div>
      )}

      {/* A standing condition rather than something that went wrong, so it is
          not dismissible and it clears itself the moment the browser changes
          its mind. Above the error band because it explains the errors: with
          no microphone to open, everything that reaches for one fails, and
          each of those failures on its own looks like a different bug.

          At the top of the app rather than on the screen that noticed. Every
          picker on every screen correctly hides itself when there is nothing
          to pick, which leaves a page with no controls and nothing saying
          why — the thing that reads as broken. */}
      {micAccess === "denied" && (
        <p className="banner error" role="alert" data-testid="mic-blocked">
          Microphone access is blocked, so there is nothing to record from.
          Allow it for this site — the control is on the icon at the left of
          the address bar — then reload.
        </p>
      )}

      {error && (
        <p className="banner error" role="alert" data-kind={errorKind}>
          {error}{" "}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </p>
      )}

      {opening ? (
        <div className="busy" role="status">
          measuring your sending…
        </div>
      ) : booting && !take.loaded ? (
        /* Holds the page's height either way, so the landing screen does not
           jump up the moment it appears. */
        <div className="busy" role="status" aria-live="polite">
          {slowBoot ? "looking for your last session…" : ""}
        </div>
      ) : configuring ? (
        <Settings
          profileId={profileId}
          onProfilesChanged={() => {
            const next = loadProfiles();
            setProfiles(next);
            // A profile can be deleted while it is the one in use, in which
            // case the store clears the selection — and an id that outlives
            // its profile would leave the app believing it is calibrated while
            // correcting by nothing.
            setProfileId(activeProfile()?.id);
          }}
          onClose={() => setConfiguring(false)}
        />
      ) : calibrating ? (
        <Calibrate
          current={profile}
          deviceId={deviceId}
          onConfigure={() => {
            setError(null);
            setConfiguring(true);
          }}
          onDeviceChange={chooseDevice}
          onError={setError}
          onSaved={(saved) => {
            setProfiles(loadProfiles());
            setProfileId(saved.id);
            setCalibrating(false);
            take.adoptKeyerSpeed();
          }}
          /* Both ways out, because the speed is stated when the wizard starts
             recording rather than when it saves a profile. Leaving without a
             usable profile still means the paddle was named, and the practice
             that follows is at that speed either way. */
          onClose={() => {
            setCalibrating(false);
            take.adoptKeyerSpeed();
          }}
        />
      ) : take.loaded && take.review ? (
        <ReviewScreen
          loaded={take.loaded}
          review={take.review}
          stack={take.reviews}
          selected={take.selected}
          onSelectRun={take.selectRun}
          onDropRun={take.dropRun}
          settings={take.settings}
          /* The intended message is not a property of the take being looked
             at — it is what you are practicing, and it outlives every attempt
             at it. Edited here it used to change only this review, so the next
             recording was graded against whatever the page had loaded with and
             the box you had just corrected was ignored. */
          onChange={(patch) => {
            take.setSettings(patch);
            if (patch.expected !== undefined) chooseIntended(patch.expected);
          }}
          onAudio={onAudio}
          onError={setError}
          deviceId={deviceId}
          onDeviceChange={chooseDevice}
          profiles={profiles}
          profileId={profileId}
          /* One control, two effects, both wanted: it is the calibration the
             next recording will be made under, and every recording already in
             the session is read again through it. */
          onCalibrate={() => {
            setError(null);
            setCalibrating(true);
          }}
          onConfigure={() => {
            setError(null);
            setConfiguring(true);
          }}
          onFile={(file) => void openFile(file)}
          onClear={() => {
            setError(null);
            take.reset();
          }}
          /* A new session is a reset that also says what the next one is
             about. The message goes up to the app as well as into the
             settings, because it outlives every attempt at it. */
          onNewSession={(next) => {
            setError(null);
            chooseIntended(next.expected);
            take.reset(next);
          }}
          onProfileChange={async (id) => {
            chooseProfile(id);
            await take.recalibrate(profiles.find((p) => p.id === id) ?? null);
          }}
          onBack={() => {
            take.clear();
            setError(null);
          }}
        />
      ) : (
        <Landing
          expected={intended}
          onExpectedChange={chooseIntended}
          onAudio={onAudio}
          onFile={(file) => void openFile(file)}
          onError={setError}
          deviceId={deviceId}
          onDeviceChange={chooseDevice}
          profiles={profiles}
          profileId={profileId}
          onProfileChange={chooseProfile}
          onCalibrate={() => {
            setError(null);
            setCalibrating(true);
          }}
          onPractice={() => {
            setError(null);
            take.reset({ expected: intended });
          }}
        />
      )}

      <Footer />
    </div>
  );
}

/** The year is read at render rather than baked in at build time, so a page
 *  left open over New Year does not claim last year's copyright. The version
 *  is the opposite and has to be: it is a fact about this build. */
function Footer(): React.ReactElement {
  return (
    <footer className="colophon">
      © {new Date().getFullYear()}{" "}
      {/* The call sign is the author, and a call sign's canonical page is its
          QRZ entry — the one place a ham looks something up. */}
      <a href="https://www.qrz.com/db/W7YFR" target="_blank" rel="noreferrer">
        W7YFR
      </a>{" "}
      {/* So a bug report can say which app it is about. Kept to the number —
          this is the quietest text on the page and it earns its place by being
          readable when someone goes looking for it, not by being noticed.

          It links to the repository rather than to the release that matches
          it: a tag is where you go to read what changed in one version, and
          nobody arrives at a number in a footer wanting that. They arrive
          wanting the source, or somewhere to report what just went wrong, and
          both of those are the repository's front page. The number stays the
          label because it is the fact worth carrying into a bug report. */}
      ·{" "}
      <a href="https://github.com/W7YFR/cwt" target="_blank" rel="noreferrer">
        v{APP_VERSION}
      </a>
    </footer>
  );
}
