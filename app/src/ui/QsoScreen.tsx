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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPlayer } from "@/audio/player";
import {
  loadPrefs,
  loadSpeed,
  loadUser,
  recallQso,
  rememberQso,
  savePrefs,
  saveSpeed,
} from "@/io/storage";
import { DEFAULT_SPEED, answer, newQso, type Qso } from "@/qso/cq";
import type { Speed } from "@/qso/speed";
import type { Station } from "@/qso/station";
import type { Length } from "@/qso/wording";
import {
  gradeCopy,
  revealed,
  type Column,
  type LockedShows,
  type Mark,
  type TheirText,
  type YourText,
} from "@/qso/show";
import { idealTimeline } from "@/timing/timeline";
import { targetTiming } from "@/timing/model";
import { IconHelp, IconUser } from "./Icons";
import { QsoGuide, QsoHelp } from "./QsoHelp";
import { PageSwitch, type Page } from "./PageSwitch";
import { LevelMeter, RecDot } from "./Record";
import {
  ChartSettingsButton,
  Check,
  ChoiceGroup,
  Section,
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

/** How long after the last key in a copy box the line that shows your
 *  sending stays hidden. */
const TYPING_QUIET_MS = 1200;

/** An over that is one plain character, other than K, R or ?: noise, not
 *  sending. A prosign alone, as <SK>, is meant. */
const NOISE_RE = /^[^KR?<]$/;

/** Characters you must have sent before the page takes it that you are
 *  sending, and locks or grades your copy. */
const SENDING_CHARS = 3;

/** The longest one over may run. The recording starts over at each over. */
const MAX_OVER_SEC = 600;

type Phase = "listening" | "waiting" | "playing";

type CopyMode = "strict" | "lenient";

interface Option<T> {
  readonly value: T;
  readonly label: string;
}

/** A length to choose: one of the script's, or a mix of them. */
type LengthChoice = Length | "mixed";

const LENGTHS: ReadonlyArray<Option<LengthChoice>> = [
  { value: "full", label: "Full" },
  { value: "short", label: "Short" },
  { value: "pieces", label: "Piece by piece" },
  { value: "mixed", label: "Mixed" },
];
const LENGTH_HELP =
  "How much the station says in each over. Full sends each item twice, Short once, and " +
  "Piece by piece sends its report, name and QTH one per over. Mixed changes from one " +
  "station to the next, and from one over to the next.";

/** With Mixed, how often a station goes piece by piece. The rest mix Full
 *  and Short, over by over. */
const MIXED_PIECES = 1 / 3;

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
  "sent, the same blurred, a box to type your copy in, or nothing. A change applies to the " +
  "lines already shown, and what you typed stays. All of it shows when the QSO ends.";
const BLUR_CALL_HELP =
  "While the station's text is blurred, a copy box or off, its call is blurred in the log " +
  "too, until the QSO ends.";

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
  /** The speed it was sent at: measured from your sending, when it could be,
   *  or the station's own. */
  readonly sentWpm: SentWpm | null;
}

/** What a reload brings back of the session: the log and the QSO under
 *  way. Not the audio. */
interface Kept {
  readonly v: 1;
  readonly lines: Line[];
  readonly closed: number[];
  readonly finished: number | null;
  readonly qso: Qso;
  readonly qsoNo: number;
  readonly theirSpeed: Speed;
  readonly piecesStation: boolean;
  readonly note: string;
  /** Stopped, not paused: Start begins afresh rather than going on. */
  readonly stopped: boolean;
  /** A reply due but not yet in the log when the page went. */
  readonly pending: Pending | null;
}

/** A reply the station is about to send, before it goes in the log. */
interface Pending {
  readonly reply: string;
  readonly them: Station;
  readonly at: Speed;
  readonly n: number;
}

/** The session as last remembered, or null if there is none or it does not
 *  read as one. A QSO that was ending when the page went ends now. */
function recallKept(): Kept | null {
  const k = recallQso() as Partial<Kept> | null;
  if (
    !k ||
    k.v !== 1 ||
    !Array.isArray(k.lines) ||
    k.lines.length === 0 ||
    !Array.isArray(k.closed) ||
    typeof k.qsoNo !== "number" ||
    typeof k.qso?.stage !== "string" ||
    typeof k.theirSpeed?.charWpm !== "number"
  ) {
    return null;
  }
  const qsoNo = k.qsoNo;
  const finished = k.finished ?? null;
  const ended = k.lines.map((l) => l.qso).filter((n) => n < qsoNo && n !== finished);
  const closed = [...new Set([...k.closed, ...ended])];
  return {
    ...(k as Kept),
    finished,
    closed,
    stopped:
      typeof k.stopped === "boolean"
        ? k.stopped
        : finished === null && !k.lines.some((l) => l.qso === qsoNo && !closed.includes(l.qso)),
    piecesStation: k.piecesStation === true,
    pending: typeof k.pending?.reply === "string" ? k.pending : null,
    note: typeof k.note === "string" ? k.note : "",
  };
}

/** A measured speed as the log writes it: 23 wpm, or 23/17 wpm. */
function wpmOf(s: SentWpm): string {
  return wpm({ charWpm: Math.round(s.charWpm), farnsworthWpm: Math.round(s.farnsworthWpm) });
}

const LOCK_HELP =
  "Your copy of the station's over can no longer change once you start sending. " +
  "Enter in the box locks it too.";
const LOCKED_SHOWS: ReadonlyArray<Option<LockedShows>> = [
  { value: "nothing", label: "My copy" },
  { value: "right", label: "What I got right" },
  { value: "grade", label: "Graded result" },
];
const LOCKED_SHOWS_HELP =
  "What a locked copy shows before the QSO ends: your copy as typed, your copy with each " +
  "character marked right or wrong, or your copy graded against what the station sent. " +
  "The graded result shows when the QSO ends.";
const SHOW_SPEED_HELP = "Each of your lines shows the speed you sent it at.";
const SHOW_THEIR_SPEED_HELP = "Each of the station's lines shows the speed it sent it at.";

/** Enter and Escape in a copy box are not the recorder's: it listens on the
 *  document, and these keys would stop the session. Enter locks the copy. */
function keepKeys(ev: React.KeyboardEvent, lock: () => void): void {
  if (ev.key === "Enter" || ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
  }
  if (ev.key === "Enter") lock();
}

/** Marked characters: a dot under each one `dot` picks, blue if right, red
 *  if not. Spaces, gaps and the characters it does not pick have none. */
function Marked({
  marks,
  dot,
}: {
  marks: readonly Mark[];
  dot(ok: boolean): boolean;
}): React.ReactElement {
  return (
    <>
      {marks.map((m, i) => (
        <span
          key={i}
          className={m.ok === null || !dot(m.ok) ? undefined : m.ok ? "cright" : "cwrong"}
        >
          {m.text}
        </span>
      ))}
    </>
  );
}

/** Your copy, with a blue dot under each character you got right and a red
 *  one under each you got wrong. A character you left out is a blank with a
 *  red dot, so a copy short of the line does not look whole. The station's
 *  characters are not shown, so nothing says what you missed. */
function RightOnly({ line }: { line: Line }): React.ReactElement {
  const grade = gradeCopy(line.text, line.typed);
  if (!line.typed.trim()) {
    return (
      <span className="text rightonly" data-testid="qso-right-only">
        (nothing copied)
      </span>
    );
  }
  const marks = grade.columns.flatMap((col): Mark[] =>
    col.yours.length > 0
      ? [...col.yours]
      : col.sent.filter((m) => m.ok === false).map(() => ({ text: " ", ok: false })),
  );
  return (
    <span className="text rightonly" data-testid="qso-right-only">
      <Marked marks={marks} dot={() => true} />
    </span>
  );
}

/** Columns split at the spaces between words: a word keeps its columns on
 *  one line, and a long line breaks between words. */
function wordsOf(columns: readonly Column[]): Column[][] {
  const words: Column[][] = [[]];
  for (const col of columns) {
    if (col.sent[0]?.text === " " && col.yours[0]?.text === " ") words.push([]);
    else words[words.length - 1]!.push(col);
  }
  return words.filter((w) => w.length > 0);
}

/** Your copy, graded: what you typed over what the station sent, lined up
 *  character by character. Blue under each character you got right, red
 *  under each you got wrong and under each you missed. Then the count. */
function Graded({ line }: { line: Line }): React.ReactElement {
  const grade = gradeCopy(line.text, line.typed);
  // Nothing copied: the station's line alone, every character missed.
  if (!line.typed.trim()) {
    return (
      <span className="text graded">
        <span className="sentcopy" data-testid="qso-aligned">
          <Marked marks={grade.sent} dot={(ok) => !ok} />
        </span>
        <span className="copied">
          Nothing copied. {grade.right} of {grade.total} copied
        </span>
      </span>
    );
  }
  return (
    <span className="text graded">
      <span className="aligned" data-testid="qso-aligned">
        {wordsOf(grade.columns).map((word, w) => (
          <span key={w} className="cword">
            {word.map((col, c) => (
              <span key={c} className="ccol">
                <span className="yourcopy">
                  <Marked marks={col.yours} dot={() => true} />
                </span>
                <span className="sentcopy">
                  <Marked marks={col.sent} dot={(ok) => !ok} />
                </span>
              </span>
            ))}
          </span>
        ))}
      </span>
      <span className="copied">
        {grade.right} of {grade.total} copied
      </span>
    </span>
  );
}

/** An on or off setting kept as a preference, with its default. */
function useOnOff(
  key: "qsoSettingsOpen" | "qsoLockCopy" | "qsoShowSpeed" | "qsoShowTheirSpeed" | "qsoBlurCall",
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

  /** The session a reload left, read once. */
  const [kept] = useState(recallKept);
  const [phase, setPhase] = useState<Phase>("listening");
  const [lines, setLines] = useState<Line[]>(() => kept?.lines ?? []);
  /** How many lines the log holds, for a timer that outlives the render. */
  const lineCount = useRef(0);
  lineCount.current = lines.length;
  const [note, setNote] = useState(() => kept?.note ?? "");
  const [copyMode, setCopyModeRaw] = useState<CopyMode>(() => loadPrefs().qsoCopy ?? "lenient");
  const setCopyMode = (mode: CopyMode) => {
    setCopyModeRaw(mode);
    savePrefs({ ...loadPrefs(), qsoCopy: mode });
  };
  const lenient = copyMode === "lenient";
  const [length, setLengthRaw] = useState<LengthChoice>(() => loadPrefs().qsoLength ?? "full");
  /** With Mixed: this station goes piece by piece. Picked for each QSO. */
  const piecesStation = useRef(kept?.piecesStation ?? Math.random() < MIXED_PIECES);
  const setLength = (next: LengthChoice) => {
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
  const [blurCall, setBlurCall] = useOnOff("qsoBlurCall", false);
  const [lockCopy, setLockCopy] = useOnOff("qsoLockCopy", true);
  const [lockedShows, setLockedShowsRaw] = useState<LockedShows>(
    () => loadPrefs().qsoLockedShows ?? "nothing",
  );
  const setLockedShows = (next: LockedShows) => {
    setLockedShowsRaw(next);
    savePrefs({ ...loadPrefs(), qsoLockedShows: next });
  };
  const [showSpeed, setShowSpeed] = useOnOff("qsoShowSpeed", false);
  const [showTheirSpeed, setShowTheirSpeed] = useOnOff("qsoShowTheirSpeed", false);
  const [helpOpen, setHelpOpen] = useState(false);
  const qso = useRef<Qso>(kept?.qso ?? newQso(Math.random, "", speed));
  /** Which QSO of the session is running, counted from 0. */
  const qsoNo = useRef(kept?.qsoNo ?? 0);
  /** The QSOs that are over. Their overs all show. */
  const [closed, setClosed] = useState<readonly number[]>(() => kept?.closed ?? []);
  /** A QSO that ends once the reply now playing ends. */
  const closing = useRef<number | null>(null);
  /** A QSO that has ended with your copy not yet graded. It closes when you
   *  start your next over, press Stop or ask for the grade. */
  const [finished, setFinished] = useState<number | null>(() => kept?.finished ?? null);
  /** The session was stopped, not paused: Start begins afresh. */
  const [stopped, setStopped] = useState(() => kept?.stopped ?? true);
  /** Pause, not Stop, is ending the session now. */
  const pausing = useRef(false);
  /** Continue was pressed: once the microphone is open, the station's last
   *  over plays again. */
  const replayOnStart = useRef(false);
  const replay = useRef<() => void>(() => {});
  /** The reply now waiting to go in the log, so a pause or a reload in the
   *  wait does not lose it. */
  const pending = useRef<Pending | null>(kept?.pending ?? null);
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
  const [theirSpeed, setTheirSpeed] = useState<Speed>(() => kept?.theirSpeed ?? speed);
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

  /** Pause, for the Enter key: bound below, once the recorder is. */
  const pauseRef = useRef<() => void>(() => {});
  const pauseKey = useCallback(() => pauseRef.current(), []);
  /** R, and Enter while paused: what the button beside them does, Start or
   *  Continue. */
  const goRef = useRef<() => void>(() => {});
  const goKey = useCallback(() => goRef.current(), []);

  const rec = useRecorder({
    deviceId,
    onClip: () => {},
    onError,
    onStart: quiet,
    onEnterKey: pauseKey,
    onStartKey: goKey,
    // Only read with nothing recording, so this is paused.
    enterStarts: !stopped && lines.length > 0,
    startKey: true,
    maxSeconds: MAX_OVER_SEC,
  });
  const { recorder } = rec;

  // Stopping the session stops the reply too, and ends the QSO. Not on
  // the first render: a QSO a reload brought back stays open to go on with.
  const hadRecorder = useRef(false);
  useEffect(() => {
    if (recorder) {
      hadRecorder.current = true;
      if (replayOnStart.current) {
        replayOnStart.current = false;
        replay.current();
      }
      return;
    }
    if (!hadRecorder.current) return;
    hadRecorder.current = false;
    quiet();
    // Paused: the QSO stays open, to go on with.
    if (pausing.current) {
      pausing.current = false;
      return;
    }
    setStopped(true);
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
  /* You are typing in a copy box. Nothing is dropped and nothing starts over:
     what the decoder reads still counts, in case you are sending as well.
     Only the line that shows your sending hides, so noise on the input does
     not appear under the box as you type. */
  const [typing, setTyping] = useState(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typed = () => {
    setTyping(true);
    if (typingTimer.current !== null) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null;
      setTyping(false);
    }, TYPING_QUIET_MS);
  };
  useEffect(
    () => () => {
      if (typingTimer.current !== null) clearTimeout(typingTimer.current);
    },
    [],
  );

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

  /** The station's over: after a short wait, it goes in the log and plays.
   *  `again` is a line already in the log to play once more, rather than a
   *  new one. */
  const sendReply = (reply: string, them: Station, at: Speed, n: number, again: number | null) => {
    setPhase("waiting");
    if (again === null) pending.current = { reply, them, at, n };
    const [lo, hi] = REPLY_DELAY_SEC;
    timer.current = setTimeout(
      () => {
        timer.current = null;
        setPhase("playing");
        const timeline = idealTimeline(reply, targetTiming(at.charWpm, at.farnsworthWpm));
        charEnds.current = timeline.chars.map((c) => c.t1);
        if (again !== null) {
          setPlaying({ line: again, shown: 0 });
        } else {
          pending.current = null;
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
              sentWpm: at,
            },
          ]);
        }
        setTheirSpeed(at);
        player.playTarget(timeline, {
          peak: 0.5,
          padSec: 0.1,
          voice: { toneHz: them.toneHz, filterQ: 3 },
        });
      },
      (lo + Math.random() * (hi - lo)) * 1000,
    );
  };

  /* Going on after a pause or a reload: you hear where the QSO was. A reply
     the pause cut off before it went in the log goes in now. Otherwise the
     station's line last in the log plays again, and nothing is added. Not
     when your over is last, with no reply to it, nor once the QSO is over. */
  replay.current = () => {
    const due = pending.current;
    if (due) {
      sendReply(due.reply, due.them, due.at, due.n, null);
      return;
    }
    const n = qsoNo.current;
    let at = lines.length - 1;
    while (at >= 0 && lines[at]!.qso !== n) at--;
    const line = lines[at];
    if (!line || line.you) return;
    const speed = line.sentWpm
      ? { charWpm: line.sentWpm.charWpm, farnsworthWpm: line.sentWpm.farnsworthWpm }
      : qso.current.speed;
    sendReply(line.text, qso.current.them, speed, n, at);
  };

  /* You have begun sending: at least `SENDING_CHARS` characters read back. A
     single character, or one still being keyed, is as often a click, a bump
     of the key or the room ringing after the reply as it is you, and taken as
     sending it locked or graded a copy while it was still being typed. */
  const sending =
    phase === "listening" &&
    copy.turn !== answered.current &&
    copy.text.replace(/\s+/g, "").length >= SENDING_CHARS;

  /* Your next over has begun: the copy of the QSO before is done. */
  useEffect(() => {
    if (finished === null || !sending) return;
    close(finished);
    setNote("");
  }, [finished, sending, close]);

  /* You have started sending: with Lock on, your copy of the station's overs
     can no longer change. */
  useEffect(() => {
    if (!lockCopy || !sending) return;
    setLines((l) =>
      l.some((line) => !line.you && line.mode === "copy" && !line.locked)
        ? l.map((line) => (!line.you && line.mode === "copy" ? { ...line, locked: true } : line))
        : l,
    );
  }, [lockCopy, sending]);

  /* Your over is done: answer it. */
  useEffect(() => {
    if (!copy.over || phase !== "listening" || !recorder) return;
    if (copy.turn === answered.current) return;
    answered.current = copy.turn;
    const heard = copy.text.trim();
    // One character alone is noise on the line, a click or a bump of the key,
    // not a turn. Not answered, and the turn starts over. K, R and ? alone
    // are answers, so they still count.
    if (NOISE_RE.test(heard)) {
      recorder.restart();
      return;
    }
    const turn = answer(qso.current, heard, {
      ear: { lenient, saved: loadUser().callsign },
      length:
        length !== "mixed"
          ? length
          : piecesStation.current
            ? "pieces"
            : Math.random() < 0.5
              ? "full"
              : "short",
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
    if (turn.ended) {
      qsoNo.current++;
      piecesStation.current = Math.random() < MIXED_PIECES;
    }
    const at = turn.qso.speed;
    setLines((l) => [...l, sent]);

    if (turn.reply === null) {
      setNote("No answer. Call CQ again.");
      recorder.restart();
      return;
    }
    if (turn.ended) closing.current = n;

    setNote("");
    sendReply(turn.reply, them, at, n, null);
  }, [copy.over, copy.text, copy.turn, phase, recorder, player, speed, lenient, length]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  /* A new session clears the page only once the microphone is open, before
     that render is painted: what was on the page, the guide or the last
     session's log, stays until then, and the session's controls replace it
     in one step. If the microphone does not open, nothing has changed. */
  const freshOnStart = useRef(false);
  /** The microphone is opening: the button says so at once, so the click
   *  is seen to land while the page waits to swap. */
  const [starting, setStarting] = useState(false);
  const fresh = useRef<() => void>(() => {});
  fresh.current = () => {
    setStopped(false);
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
  };
  useLayoutEffect(() => {
    if (!recorder || !freshOnStart.current) return;
    freshOnStart.current = false;
    fresh.current();
  }, [recorder]);
  const start = () => {
    player.wake();
    replayOnStart.current = false;
    freshOnStart.current = true;
    setStarting(true);
    void rec.start().finally(() => setStarting(false));
  };

  /** Go on with the QSO a reload brought back: the log and the QSO stay. */
  const resume = () => {
    player.wake();
    freshOnStart.current = false;
    setStarting(true);
    setStopped(false);
    setPlaying(null);
    answered.current = -1;
    replayOnStart.current = true;
    void rec.start().finally(() => setStarting(false));
  };

  /** End the session but not the QSO: Continue goes on with it. */
  const pause = () => {
    pausing.current = true;
    void rec.discard();
  };
  pauseRef.current = pause;

  /* Remember the session as it changes, so a reload comes back to it. The
     QSO itself moves with the log: each over you send adds a line. */
  useEffect(() => {
    rememberQso(
      lines.length === 0
        ? null
        : {
            v: 1,
            lines,
            closed: [...closed],
            finished,
            qso: qso.current,
            qsoNo: qsoNo.current,
            theirSpeed,
            piecesStation: piecesStation.current,
            note,
            stopped,
            pending: pending.current,
          },
    );
    // The phase, for a reply that is due: it is kept as soon as it is.
  }, [lines, closed, finished, theirSpeed, note, stopped, phase]);

  /** Paused, or a reload came back to a session under way: Continue goes
   *  on with it, where Start would clear the log. */
  const open = !recorder && !stopped && lines.length > 0;
  goRef.current = open ? resume : start;

  const setTyped = (at: number, typed: string) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, typed } : line)));
  const lock = (at: number) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, locked: true } : line)));

  /** How one of the station's overs shows. Every choice applies to the
   *  overs already shown, but Copy: switched on mid-QSO, it does not turn
   *  overs already read into boxes. An over that arrived under Copy keeps
   *  what you typed whatever shows, and shows it again under Copy, locked
   *  if it was. */
  const theirModeOf = (line: Line): TheirText => {
    if (theirText !== "copy") return theirText;
    return line.mode === "copy" ? "copy" : line.mode;
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

  /** The label of a line: who sent it, blurred when Blur call with copy is
   *  on and the line's text is not shown as it is. */
  const labelOf = (line: Line): React.ReactElement => {
    const mode = theirModeOf(line);
    const blurred =
      blurCall &&
      !line.you &&
      !closed.includes(line.qso) &&
      (mode === "hidden" || mode === "copy" || mode === "none");
    return blurred ? (
      <span className="who blurred" aria-hidden="true" data-testid="qso-who-blurred">
        {line.who}
      </span>
    ) : (
      <span className="who">{whoOf(line)}</span>
    );
  };

  /** What shows of one line of the log. */
  const textOf = (line: Line, at: number): React.ReactElement => {
    const over = closed.includes(line.qso);
    const mode = line.you ? yourText : theirModeOf(line);
    // The grade is the record of a copy: it stays, whatever shows now.
    if (over && !line.you && line.mode === "copy") return <Graded line={line} />;
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
          onKeyDown={(ev) => {
            typed();
            keepKeys(ev, () => lock(at));
          }}
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
    ? open
      ? "Press Continue to go on with the QSO."
      : "Press Start, then call CQ."
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
                <ChoiceGroup
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
          /* What is set for this page alone, on a row under the audio and
             the speed, which both pages share. */
          pageRow={
            <>
              <Section name="qso" title="QSO">
                <div className="panelgroups">
                  <ChoiceGroup
                    id="qso-copy"
                    label="Copy"
                    help={COPY_HELP}
                    value={copyMode}
                    options={COPY_MODES}
                    onChange={(v) => setCopyMode(v as CopyMode)}
                  />
                  <ChoiceGroup
                    id="qso-length"
                    label="Length"
                    help={LENGTH_HELP}
                    value={length}
                    options={LENGTHS}
                    onChange={(v) => setLength(v as LengthChoice)}
                  />
                </div>
              </Section>
              <Section name="theirs" title="Station text">
                <div className="panelgroups">
                  <ChoiceGroup
                    id="qso-their-text"
                    label="Shows"
                    help={THEIR_TEXT_HELP}
                    value={theirText}
                    options={THEIR_TEXTS}
                    onChange={(v) => setTheirText(v as TheirText)}
                  />
                  <Check
                    id="qso-blur-call"
                    label="Blur call with copy"
                    help={BLUR_CALL_HELP}
                    checked={blurCall}
                    onChange={setBlurCall}
                  />
                  <Check
                    id="qso-show-their-speed"
                    label="Speed"
                    help={SHOW_THEIR_SPEED_HELP}
                    checked={showTheirSpeed}
                    onChange={setShowTheirSpeed}
                  />
                </div>
              </Section>
              <Section name="yours" title="Your text">
                <div className="panelgroups">
                  <ChoiceGroup
                    id="qso-your-text"
                    label="Shows"
                    help={YOUR_TEXT_HELP}
                    value={yourText}
                    options={YOUR_TEXTS}
                    onChange={(v) => setYourText(v as YourText)}
                  />
                  <Check
                    id="qso-show-speed"
                    label="Speed"
                    help={SHOW_SPEED_HELP}
                    checked={showSpeed}
                    onChange={setShowSpeed}
                  />
                </div>
              </Section>
            </>
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
              data-testid={open ? "qso-continue" : "qso-start"}
              disabled={rec.probing || rec.blocked || rec.busy || starting}
              onClick={open ? resume : start}
            >
              <RecDot /> {starting ? "Starting…" : open ? "Continue" : "Start"}
            </button>
          ) : (
            <>
              <button data-testid="qso-pause" onClick={pause}>
                Pause
              </button>
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
              {labelOf(line)}
              {textOf(line, i)}
              {(line.you ? showSpeed : showTheirSpeed) && line.sentWpm && (
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
            !typing &&
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

        {open && (
          <p className="legend keys" data-testid="qso-hotkeys">
            <kbd>R</kbd> or <kbd>Enter</kbd> continue
          </p>
        )}
        {recorder && (
          <p className="legend keys" data-testid="qso-hotkeys">
            <kbd>R</kbd> restart your turn &nbsp;·&nbsp; <kbd>Enter</kbd> pause &nbsp;·&nbsp;{" "}
            <kbd>Esc</kbd> stop
          </p>
        )}
      </main>
    </>
  );
}
