/* The QSO page: call CQ, and work the station that answers.
 *
 * One recording runs for the whole session. Each over you send is copied
 * live, and when you hand the turn over, the script in qso/ answers it and
 * the answer plays. While it plays, the microphone is not copied, so the
 * reply coming back through the speakers is not read as your sending. When
 * it ends, the recording starts over, and the next over is yours.
 *
 * What shows of each over is a choice, one for the station and one for you.
 * The station's can come whole, a character at a time as it is sent, blurred,
 * as a box to type your copy in, or not at all. At the end of a QSO,
 * everything hidden shows, and your copy is graded.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPlayer } from "@/audio/player";
import { loadPrefs, loadSpeed, loadUser, savePrefs, saveSpeed } from "@/io/storage";
import { DEFAULT_SPEED, answer, newQso, type Qso } from "@/qso/cq";
import type { Speed } from "@/qso/speed";
import type { Length } from "@/qso/wording";
import { gradeCopy, revealed, type LockedShows, type TheirText, type YourText } from "@/qso/show";
import { idealTimeline } from "@/timing/timeline";
import { targetTiming } from "@/timing/model";
import { IconHelp, IconUser } from "./Icons";
import { QsoGuide, QsoHelp } from "./QsoHelp";
import { PageSwitch, type Page } from "./PageSwitch";
import { LevelMeter, RecDot } from "./Record";
import {
  ChartSettingsButton,
  Check,
  Section,
  SelectGroup,
  SettingsBand,
  SettingsPanel,
  SpeedSliders,
} from "./Controls";
import { calibrationOf, profileForSource, type Profile } from "@/io/profiles";
import type { SentWpm } from "@/timing/live";
import { useLiveCopy } from "./useLiveCopy";
import { useRecorder } from "./useRecorder";
import { APP_NAME, Brandmark } from "./Wordmark";
import { visitWordmark } from "./wordmarks";

/** A speed as the app writes it: 25 wpm, or 25/16 wpm with Farnsworth. */
function wpm(s: Speed): string {
  return s.charWpm === s.farnsworthWpm ? `${s.charWpm} wpm` : `${s.charWpm}/${s.farnsworthWpm} wpm`;
}

function same(a: Speed, b: Speed): boolean {
  return a.charWpm === b.charWpm && a.farnsworthWpm === b.farnsworthWpm;
}

/** How long the other station takes to start its reply, in seconds. */
const REPLY_DELAY_SEC = [0.6, 1.4] as const;

/** How long after a reply ends before the microphone is copied again. The
 *  last of the reply can still be in the room. */
const AFTER_REPLY_MS = 250;

/** The longest one over may run. The recording starts over at each over. */
const MAX_OVER_SEC = 600;

type Phase = "listening" | "waiting" | "playing";

type CopyMode = "strict" | "lenient";

interface Option<T> {
  readonly value: T;
  readonly label: string;
}

const LENGTHS: ReadonlyArray<Option<Length>> = [
  { value: "full", label: "Full" },
  { value: "short", label: "Short" },
  { value: "pieces", label: "Piece by piece" },
];
const LENGTH_HELP =
  "How much the station says in each over. Full sends each item twice, Short once, and " +
  "Piece by piece sends its report, name and QTH one per over.";

const COPY_MODES: ReadonlyArray<Option<CopyMode>> = [
  { value: "lenient", label: "Lenient" },
  { value: "strict", label: "Strict" },
];
const COPY_HELP =
  "How the station reads your sending. Lenient reads it at your own spacing and takes a " +
  "call with one character wrong. Strict reads it at your speed and takes only calls sent exactly.";

const THEIR_TEXTS: ReadonlyArray<Option<TheirText>> = [
  { value: "before", label: "Whole" },
  { value: "sent", label: "As sent" },
  { value: "hidden", label: "Blurred" },
  { value: "copy", label: "Copy" },
  { value: "none", label: "Off" },
];
const THEIR_TEXT_HELP =
  "What shows of the station's overs: whole as soon as one starts, each character as it is " +
  "sent, the same blurred, a box to type your copy in, or nothing. All of it shows when the QSO ends.";

const YOUR_TEXTS: ReadonlyArray<Option<YourText>> = [
  { value: "sent", label: "As sent" },
  { value: "hidden", label: "Blurred" },
  { value: "none", label: "Off" },
];
const YOUR_TEXT_HELP =
  "What shows of your own overs as you send them: each character, the same blurred, or nothing.";

interface Line {
  readonly who: string;
  readonly text: string;
  /** Sent by you, as copied. */
  readonly you: boolean;
  /** Which QSO of the session it belongs to. */
  readonly qso: number;
  /** Your copy of it, for the station's overs. */
  readonly typed: string;
  /** The station text it arrived under, for the station's overs. */
  readonly mode: TheirText;
  /** Copy mode: your copy can no longer change. */
  readonly locked: boolean;
  /** The speed you sent it at, for your overs, when it could be measured. */
  readonly sentWpm: SentWpm | null;
}

/** A measured speed as the log writes it: 23 wpm, or 23/17 wpm. */
function wpmOf(s: SentWpm): string {
  return wpm({ charWpm: Math.round(s.charWpm), farnsworthWpm: Math.round(s.farnsworthWpm) });
}

const LOCK_HELP =
  "Your copy of the station's over can no longer change once you start sending. " +
  "Enter in the box locks it too.";
const LOCKED_SHOWS: ReadonlyArray<Option<LockedShows>> = [
  { value: "nothing", label: "Nothing yet" },
  { value: "grade", label: "The grade" },
  { value: "right", label: "What I got right" },
];
const LOCKED_SHOWS_HELP =
  "What a locked copy shows before the QSO ends: nothing yet, the grade, or only the " +
  "characters you copied right, with nothing to mark what you missed. The full grade " +
  "shows when the QSO ends.";
const SHOW_SPEED_HELP = "Each of your overs shows the speed you sent it at.";

/** Enter and Escape in a copy box are not the recorder's: it listens on the
 *  document, and these keys would stop the session. Enter locks the copy. */
function keepKeys(ev: React.KeyboardEvent, lock: () => void): void {
  if (ev.key === "Enter" || ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
  }
  if (ev.key === "Enter") lock();
}

/** Your copy of an over, showing only what you got right. Each character
 *  you got right is in its place. Every other one is a dot, so nothing says
 *  which you missed or what they were. */
function RightOnly({ line }: { line: Line }): React.ReactElement {
  const grade = gradeCopy(line.text, line.typed);
  return (
    <span className="text rightonly" data-testid="qso-right-only">
      {grade.marks.map((m, i) =>
        m.ok === null ? (
          <span key={i}>{m.text}</span>
        ) : m.ok ? (
          <span key={i} className="cright">
            {m.text}
          </span>
        ) : (
          <span key={i} className="unknown">
            ·
          </span>
        ),
      )}
    </span>
  );
}

/** Your copy of an over, graded. */
function Graded({ line }: { line: Line }): React.ReactElement {
  const grade = gradeCopy(line.text, line.typed);
  return (
    <span className="text graded">
      <span>
        {grade.marks.map((m, i) => (
          <span key={i} className={m.ok === null ? undefined : m.ok ? "cright" : "cwrong"}>
            {m.text}
          </span>
        ))}
      </span>
      <span className="copied">
        You copied {line.typed.trim() ? line.typed.toUpperCase() : "nothing"} · {grade.right} of{" "}
        {grade.total}
      </span>
    </span>
  );
}

/** An on or off setting kept as a preference, with its default. */
function useOnOff(
  key: "qsoSettingsOpen" | "qsoLockCopy" | "qsoShowSpeed",
  or: boolean,
): readonly [boolean, (next: boolean) => void] {
  const [value, setRaw] = useState<boolean>(() => loadPrefs()[key] ?? or);
  const set = (next: boolean) => {
    setRaw(next);
    savePrefs({ ...loadPrefs(), [key]: next });
  };
  return [value, set];
}

export interface QsoScreenProps {
  deviceId: string | undefined;
  onDeviceChange(id: string | undefined): void;
  /** The saved calibrations, and the one in use. */
  profiles: readonly Profile[];
  profileId: string | undefined;
  onProfileChange(id: string | undefined): void;
  /** Open the calibration wizard. */
  onCalibrate(): void;
  onError(message: string): void;
  onConfigure(): void;
  onPage(page: Page): void;
}

export function QsoScreen({
  deviceId,
  onDeviceChange,
  profiles,
  profileId,
  onProfileChange,
  onCalibrate,
  onError,
  onConfigure,
  onPage,
}: QsoScreenProps): React.ReactElement {
  /* Your speed: the one the practice page uses, read and written through the
     same pair. Set before a session, since the copy is read at it. */
  const [speed, setSpeedRaw] = useState<Speed>(() => loadSpeed() ?? DEFAULT_SPEED);
  const setSpeed = (next: Speed) => {
    const fixed = { ...next, farnsworthWpm: Math.min(next.farnsworthWpm, next.charWpm) };
    setSpeedRaw(fixed);
    setTheirSpeed(fixed);
    saveSpeed(fixed.charWpm, fixed.farnsworthWpm);
  };

  const [phase, setPhase] = useState<Phase>("listening");
  const [lines, setLines] = useState<Line[]>([]);
  /** How many lines the log holds, for a timer that outlives the render. */
  const lineCount = useRef(0);
  lineCount.current = lines.length;
  const [note, setNote] = useState("");
  const [copyMode, setCopyModeRaw] = useState<CopyMode>(() => loadPrefs().qsoCopy ?? "lenient");
  const setCopyMode = (mode: CopyMode) => {
    setCopyModeRaw(mode);
    savePrefs({ ...loadPrefs(), qsoCopy: mode });
  };
  const lenient = copyMode === "lenient";
  const [length, setLengthRaw] = useState<Length>(() => loadPrefs().qsoLength ?? "full");
  const setLength = (next: Length) => {
    setLengthRaw(next);
    savePrefs({ ...loadPrefs(), qsoLength: next });
  };
  const [theirText, setTheirTextRaw] = useState<TheirText>(() => loadPrefs().qsoTheirText ?? "before");
  /** For the timer that adds the station's over to the log. */
  const theirMode = useRef(theirText);
  theirMode.current = theirText;
  const setTheirText = (next: TheirText) => {
    setTheirTextRaw(next);
    savePrefs({ ...loadPrefs(), qsoTheirText: next });
  };
  const [yourText, setYourTextRaw] = useState<YourText>(() => loadPrefs().qsoYourText ?? "sent");
  const setYourText = (next: YourText) => {
    setYourTextRaw(next);
    savePrefs({ ...loadPrefs(), qsoYourText: next });
  };
  const [settingsOpen, setSettingsOpen] = useOnOff("qsoSettingsOpen", false);
  const [lockCopy, setLockCopy] = useOnOff("qsoLockCopy", true);
  const [lockedShows, setLockedShowsRaw] = useState<LockedShows>(
    () => loadPrefs().qsoLockedShows ?? "nothing",
  );
  const setLockedShows = (next: LockedShows) => {
    setLockedShowsRaw(next);
    savePrefs({ ...loadPrefs(), qsoLockedShows: next });
  };
  const [showSpeed, setShowSpeed] = useOnOff("qsoShowSpeed", false);
  const [helpOpen, setHelpOpen] = useState(false);
  const qso = useRef<Qso>(newQso(Math.random, "", speed));
  /** Which QSO of the session is running, counted from 0. */
  const qsoNo = useRef(0);
  /** The QSOs that are over. Their overs all show. */
  const [closed, setClosed] = useState<readonly number[]>([]);
  /** A QSO that ends once the reply now playing ends. */
  const closing = useRef<number | null>(null);
  /** A QSO that has ended with your copy not yet graded. It closes when you
   *  start your next over, press Stop or ask for the grade. */
  const [finished, setFinished] = useState<number | null>(null);
  const finishedRef = useRef<number | null>(null);
  finishedRef.current = finished;

  /** End QSO `n`: everything in it shows, and your copy is graded. */
  const close = useCallback((n: number) => {
    setClosed((c) => (c.includes(n) ? c : [...c, n]));
    setFinished((f) => (f === n ? null : f));
  }, []);
  /** The station's over now playing, as a line, and how many of its
   *  characters have been sent. */
  const [playing, setPlaying] = useState<{ line: number; shown: number } | null>(null);
  /** When each character of the over now playing ends, in seconds. */
  const charEnds = useRef<number[]>([]);
  /** How fast the station sends, after QRS or QRQ. */
  const [theirSpeed, setTheirSpeed] = useState<Speed>(speed);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const afterReply = useRef<() => void>(() => {});
  /** The last over answered. */
  const answered = useRef(-1);

  const player = useMemo(
    () =>
      createPlayer({
        onProgress: (t) => {
          const shown = charEnds.current.filter((end) => end <= t).length;
          setPlaying((p) => (p && p.shown !== shown ? { ...p, shown } : p));
        },
        onEnded: (reason) => {
          setPlaying(null);
          if (reason === "done") afterReply.current();
        },
      }),
    [],
  );
  useEffect(() => () => player.destroy(), [player]);

  /* How loud the station plays: the practice page's listening level, kept in
     the same preference. */
  const [gainDb, setGainDbRaw] = useState(() => loadPrefs().gainDb ?? 0);
  const setGainDb = (next: number) => {
    setGainDbRaw(next);
    savePrefs({ ...loadPrefs(), gainDb: next });
  };
  useEffect(() => player.setGainDb(gainDb), [player, gainDb]);

  const quiet = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    player.stop();
    setPhase("listening");
  }, [player]);

  const rec = useRecorder({
    deviceId,
    onClip: () => {},
    onError,
    onStart: quiet,
    startKey: true,
    maxSeconds: MAX_OVER_SEC,
  });
  const { recorder } = rec;

  // Stopping the session stops the reply too, and ends the QSO.
  useEffect(() => {
    if (recorder) return;
    quiet();
    close(qsoNo.current);
    if (finishedRef.current !== null) close(finishedRef.current);
  }, [recorder, quiet, close]);

  const source = useMemo(
    () => (recorder ? { recorder, ...speed } : null),
    [recorder, speed],
  );
  /* The calibration in use, as the decoder takes it. Always the microphone
     here, so it always applies. */
  const calibration = useMemo(() => {
    const profile = profileForSource(profiles.find((p) => p.id === profileId) ?? null, true);
    return profile ? calibrationOf(profile) : null;
  }, [profiles, profileId]);
  const copy = useLiveCopy(source, phase === "listening", lenient, calibration);

  afterReply.current = () => {
    timer.current = setTimeout(() => {
      timer.current = null;
      recorder?.restart();
      setPhase("listening");
      // The last over has played: now the QSO is over. With copy to grade,
      // it waits for you to finish typing.
      if (closing.current !== null) {
        const n = closing.current;
        closing.current = null;
        if (lines.some((l) => l.qso === n && !l.you && l.mode === "copy")) {
          setFinished(n);
          setNote("The QSO is over. Finish your copy, then call CQ for the next one.");
        } else {
          close(n);
          setNote("The QSO is over. Call CQ for the next one.");
        }
      }
      // A new station starts at your speed.
      if (!qso.current.last) setTheirSpeed(speed);
    }, AFTER_REPLY_MS);
  };

  /* Your next over has begun: the copy of the QSO before is done. */
  useEffect(() => {
    if (finished === null || phase !== "listening" || copy.turn === answered.current) return;
    if (!copy.text && !copy.keying) return;
    close(finished);
    setNote("");
  }, [finished, phase, copy.turn, copy.text, copy.keying, close]);

  /* You have started sending: with Lock on, your copy of the station's overs
     can no longer change. */
  useEffect(() => {
    if (!lockCopy || phase !== "listening" || copy.turn === answered.current) return;
    if (!copy.text && !copy.keying) return;
    setLines((l) =>
      l.some((line) => !line.you && line.mode === "copy" && !line.locked)
        ? l.map((line) => (!line.you && line.mode === "copy" ? { ...line, locked: true } : line))
        : l,
    );
  }, [lockCopy, phase, copy.turn, copy.text, copy.keying]);

  /* Your over is done: answer it. */
  useEffect(() => {
    if (!copy.over || phase !== "listening" || !recorder) return;
    if (copy.turn === answered.current) return;
    answered.current = copy.turn;
    const heard = copy.text.trim();
    const turn = answer(qso.current, heard, {
      ear: { lenient, saved: loadUser().callsign },
      length,
    });
    const them = turn.qso.them;
    const n = qsoNo.current;
    const sent: Line = {
      who: turn.qso.you || "You",
      text: heard,
      you: true,
      qso: n,
      typed: "",
      mode: "before",
      locked: false,
      sentWpm: copy.sentWpm,
    };

    qso.current = turn.ended ? newQso(Math.random, turn.qso.you, speed) : turn.qso;
    if (turn.ended) qsoNo.current++;
    const at = turn.qso.speed;
    setLines((l) => [...l, sent]);

    if (turn.reply === null) {
      setNote("No answer. Call CQ again.");
      recorder.restart();
      return;
    }
    if (turn.ended) closing.current = n;

    const reply = turn.reply;
    setNote("");
    setPhase("waiting");
    const [lo, hi] = REPLY_DELAY_SEC;
    timer.current = setTimeout(
      () => {
        timer.current = null;
        setPhase("playing");
        const timeline = idealTimeline(reply, targetTiming(at.charWpm, at.farnsworthWpm));
        charEnds.current = timeline.chars.map((c) => c.t1);
        // Your over went in the log at least one render ago.
        setPlaying({ line: lineCount.current, shown: 0 });
        setLines((l) => [
          ...l,
          {
            who: them.call,
            text: reply,
            you: false,
            qso: n,
            typed: "",
            mode: theirMode.current,
            locked: false,
            sentWpm: null,
          },
        ]);
        setTheirSpeed(at);
        player.playTarget(timeline, {
          peak: 0.5,
          padSec: 0.1,
          voice: { toneHz: them.toneHz, filterQ: 3 },
        });
      },
      (lo + Math.random() * (hi - lo)) * 1000,
    );
  }, [copy.over, copy.text, copy.turn, phase, recorder, player, speed, lenient, length]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const start = () => {
    player.wake();
    setLines([]);
    setNote("");
    setClosed([]);
    setPlaying(null);
    qsoNo.current = 0;
    closing.current = null;
    setFinished(null);
    qso.current = newQso(Math.random, "", speed);
    setTheirSpeed(speed);
    answered.current = -1;
    void rec.start();
  };

  const setTyped = (at: number, typed: string) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, typed } : line)));
  const lock = (at: number) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, locked: true } : line)));

  /** How one of the station's overs shows. Copy holds for the overs that
   *  arrived under it, and only for those: switched on mid-QSO, it does not
   *  turn overs already read into boxes, and switched off, it does not throw
   *  away what was typed. The other choices apply to every over at once. */
  const theirModeOf = (line: Line): TheirText => {
    if (line.mode === "copy") return "copy";
    return theirText === "copy" ? line.mode : theirText;
  };

  /** Whether you have the station's call in QSO `n`: the exact call in one
   *  of your overs as copied, or in what you typed of one of its overs. */
  const identified = (n: number, call: string): boolean =>
    lines.some(
      (l) =>
        l.qso === n &&
        (l.you ? l.text : l.typed).toUpperCase().replace(/\s+/g, "").includes(call),
    );

  /** Who sent a line. The station's call shows only once you have it, when
   *  the over shows whole, or when the QSO is over. Until then, Station. */
  const whoOf = (line: Line): string => {
    if (line.you) return line.who;
    if (closed.includes(line.qso) || theirModeOf(line) === "before") return line.who;
    return identified(line.qso, line.who) ? line.who : "Station";
  };

  /** What shows of one line of the log. */
  const textOf = (line: Line, at: number): React.ReactElement => {
    const over = closed.includes(line.qso);
    const mode = line.you ? yourText : theirModeOf(line);
    if (over && mode === "copy") return <Graded line={line} />;
    if (over || mode === "before") {
      return <span className="text">{line.text || "(nothing copied)"}</span>;
    }
    if (mode === "none") return <span className="text off">not shown</span>;
    if (mode === "copy" && line.locked) {
      if (lockedShows === "grade") return <Graded line={line} />;
      if (lockedShows === "right") return <RightOnly line={line} />;
      return (
        <span className="text locked" data-testid="qso-locked">
          {line.typed.trim() ? line.typed.toUpperCase() : "(nothing copied)"}
        </span>
      );
    }
    if (mode === "copy") {
      return (
        <input
          className="qsotype"
          data-testid="qso-type"
          aria-label={`Your copy of ${whoOf(line)}`}
          value={line.typed}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(ev) => keepKeys(ev, () => lock(at))}
          onChange={(ev) => setTyped(at, ev.target.value)}
        />
      );
    }
    const shown = playing?.line === at ? revealed(line.text, playing.shown) : line.text;
    return (
      <span className={mode === "hidden" ? "text blurred" : "text"} aria-hidden={mode === "hidden"}>
        {shown || (line.you ? "(nothing copied)" : "")}
      </span>
    );
  };

  /* The guide is on the page while there is nothing else to show: no session
     running and nothing sent. It goes when the microphone opens, in the same
     step as Stop and the level meter, and comes back after a session that
     sent nothing. Behind the ? the rest of the time. */
  const guideShown = !recorder && lines.length === 0;

  const status = !recorder
    ? "Press Start, then call CQ."
    : phase === "listening"
      ? qso.current.stage === "cq"
        ? "Call CQ to make a contact."
        : "Your turn."
      : phase === "waiting"
        ? "Waiting for the other station."
        : "The other station is sending.";

  return (
    <>
      <header>
        <h1 className="brand" aria-label={APP_NAME}>
          <span className="brandmark">
            <Brandmark art={visitWordmark()} />
          </span>
        </h1>
        <PageSwitch page="qso" onPage={onPage} disabled={recorder !== null} />
        <div className="cornergroup">
          <button
            className="iconbtn cornerbtn"
            aria-label="Configuration"
            title="Configuration"
            onClick={onConfigure}
            disabled={recorder !== null}
          >
            <IconUser />
          </button>
          <ChartSettingsButton open={settingsOpen} onToggle={() => setSettingsOpen(!settingsOpen)} />
        </div>
      </header>

      {/* The settings both pages share, then this page's own. */}
      <SettingsBand open={settingsOpen}>
        <SettingsPanel
          className="qsopanel"
          audio={{
            devices: rec.devices,
            deviceId,
            onDeviceChange,
            profiles,
            profileId,
            onProfileChange,
            // Always the microphone here, so a calibration always applies.
            appliesToTake: true,
            rereading: false,
            onCalibrate,
            // The session holds the microphone open, and its copy is read
            // through this correction.
            locked: recorder !== null,
          }}
          gainDb={gainDb}
          onGainDb={setGainDb}
          modesTitle="Station text modes"
          modes={
            <Section name="copy" title="Copy">
              <div className="aid">
                <Check
                  id="qso-lock-copy"
                  label="Lock when I send"
                  help={LOCK_HELP}
                  checked={lockCopy}
                  onChange={setLockCopy}
                />
                <SelectGroup
                  id="qso-locked-shows"
                  label="Once locked, show"
                  help={LOCKED_SHOWS_HELP}
                  value={lockedShows}
                  options={LOCKED_SHOWS}
                  onChange={(v) => setLockedShows(v as LockedShows)}
                />
              </div>
            </Section>
          }
        >
          {/* The practice page's speed sliders. They lock while a session
              runs: your copy is read at this speed. */}
          <Section name="speed" title="Speed">
            <div className="panelgroups">
              <SpeedSliders
                charWpm={speed.charWpm}
                farnsworthWpm={speed.farnsworthWpm}
                onChange={(patch) => setSpeed({ ...speed, ...patch })}
                locked={recorder !== null}
              />
            </div>
          </Section>
          <Section name="qso" title="QSO">
            <div className="panelgroups">
              <SelectGroup
                id="qso-copy"
                label="Copy"
                help={COPY_HELP}
                value={copyMode}
                options={COPY_MODES}
                onChange={(v) => setCopyMode(v as CopyMode)}
              />
              <SelectGroup
                id="qso-length"
                label="Length"
                help={LENGTH_HELP}
                value={length}
                options={LENGTHS}
                onChange={(v) => setLength(v as Length)}
              />
            </div>
          </Section>
          <Section name="theirs" title="Station text">
            <div className="panelgroups">
              <SelectGroup
                id="qso-their-text"
                label="Shows"
                help={THEIR_TEXT_HELP}
                value={theirText}
                options={THEIR_TEXTS}
                onChange={(v) => setTheirText(v as TheirText)}
              />
            </div>
          </Section>
          <Section name="yours" title="Your text">
            <div className="panelgroups">
              <SelectGroup
                id="qso-your-text"
                label="Shows"
                help={YOUR_TEXT_HELP}
                value={yourText}
                options={YOUR_TEXTS}
                onChange={(v) => setYourText(v as YourText)}
              />
              <Check
                id="qso-show-speed"
                label="Speed on each line"
                help={SHOW_SPEED_HELP}
                checked={showSpeed}
                onChange={setShowSpeed}
              />
            </div>
          </Section>
        </SettingsPanel>
      </SettingsBand>

      {helpOpen && (
        <QsoHelp onClose={() => setHelpOpen(false)} onSettings={() => setSettingsOpen(true)} />
      )}

      <main className="panel qso" data-testid="qso">
        <p className="qsostatus" role="status" aria-live="polite">
          {status}
        </p>

        <div className="qsocontrols">
          {rec.needAccess ? (
            <button className="primary" disabled={rec.blocked} onClick={() => void rec.grantAccess()}>
              Allow the microphone
            </button>
          ) : !recorder ? (
            <button
              className="primary"
              data-testid="qso-start"
              disabled={rec.probing || rec.blocked || rec.busy}
              onClick={start}
            >
              <RecDot /> Start
            </button>
          ) : (
            <>
              <button data-testid="qso-stop" onClick={() => void rec.discard()}>
                Stop
              </button>
              <LevelMeter level={rec.level} />
            </>
          )}
          {/* Your speed does two jobs: your sending is copied at it, and each
              new station answers at it. QRS and QRQ change the station's speed
              alone. */}
          {/* Only once QRS or QRQ has moved it: a station starts at your speed,
              and the guide says so. */}
          {!same(theirSpeed, speed) && (
            <span className="hint" data-testid="qso-their-speed">
              The station sends at {wpm(theirSpeed)}.
            </span>
          )}
          {/* The guide, when it is not on the page: last in the row, at its
              right end. */}
          {!guideShown && (
            <button
              type="button"
              className="iconbtn helpbtn qsohelpbtn"
              data-testid="qso-help-open"
              aria-label="Anatomy of a QSO"
              title="Anatomy of a QSO"
              onClick={() => setHelpOpen(true)}
            >
              <IconHelp />
            </button>
          )}
        </div>

        {guideShown && (
          <div className="qsoguide prose" data-testid="qso-guide">
            <QsoGuide onSettings={() => setSettingsOpen(true)} />
          </div>
        )}

        <ol className="qsolog" data-testid="qso-log">
          {lines.map((line, i) => (
            <li key={i} className={line.you ? "you" : "them"}>
              <span className="who">{whoOf(line)}</span>
              {textOf(line, i)}
              {showSpeed && line.you && line.sentWpm && (
                <span className="lwpm" data-testid="qso-line-wpm">
                  {wpmOf(line.sentWpm)}
                </span>
              )}
            </li>
          ))}
          {/* Not an over already answered: after a reply, the last one is
              still the copy until the recording starts over. */}
          {recorder &&
            phase === "listening" &&
            copy.turn !== answered.current &&
            yourText !== "none" &&
            (copy.text || copy.keying) && (
            <li className="you live">
              <span className="who">{qso.current.you || "You"}</span>
              <span
                className={yourText === "hidden" ? "text blurred" : "text"}
                aria-hidden={yourText === "hidden"}
              >
                {copy.text}
                {copy.keying && <span className="keying"> {copy.keying}</span>}
              </span>
            </li>
          )}
        </ol>

        {note && (
          <p className="hint qsonote">
            {note}
            {finished !== null && (
              <>
                {" "}
                <button
                  className="link"
                  data-testid="qso-grade"
                  onClick={() => {
                    close(finished);
                    setNote("The QSO is over. Call CQ for the next one.");
                  }}
                >
                  Grade my copy
                </button>
              </>
            )}
          </p>
        )}

        {recorder && (
          <p className="legend keys" data-testid="qso-hotkeys">
            <kbd>R</kbd> restart your turn &nbsp;·&nbsp; <kbd>Enter</kbd> or <kbd>Esc</kbd> stop
          </p>
        )}
      </main>
    </>
  );
}
