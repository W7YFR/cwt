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

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPlayer } from "@/audio/player";
import { fadeOf, NOISE_OFF_DB, seedOf, type Fade } from "@/audio/qsb";
import type { Band } from "@/audio/player";
import { bandAudio, bandOn as anyBand, QRM_OFF_DB } from "@/copy/band";
import { qrmLines } from "@/copy/generate";
import { encodeWav, encodeWavBuffer } from "@/audio/wav";
import {
  loadPrefs,
  loadSpeed,
  loadUser,
  forgetQsoOvers,
  keepQsoOver,
  recallQso,
  recallQsoOvers,
  rememberQso,
  savePrefs,
  saveSpeed,
} from "@/io/storage";
import { DEFAULT_SPEED, newQso, type Qso } from "@/qso/cq";
import { FORMATS } from "@/qso/formats";
import { fmtSpeed } from "./format";
import { callIn, following, isRun, respond, type AnyQso } from "@/qso/run";
import { hint, meOf, seededVoice, THEIR_CALL, THEIR_NAME } from "@/qso/hint";
import { exchangeReport } from "@/qso/report";
import { vocabulary } from "@/qso/vocabulary";
import type { GuideId } from "@/qso/examples";
import type { Speed } from "@/qso/speed";
import type { Station } from "@/qso/station";
import type { Length } from "@/qso/wording";
import { anyAdded, lineAudio, tape, trimmed, type Added, type Clip, type TapeLine } from "@/qso/tape";
import { gradeCopy, revealed, type LockedShows, type TheirText, type YourText } from "@/qso/show";
import { charsOf, copyText, overOfText, type CopyInput, type LineCopy } from "@/copy/lines";
import type { Over } from "@/copy/decode";
import { idealTimeline } from "@/timing/timeline";
import { targetTiming } from "@/timing/model";
import { IconDownload, IconEdit, IconHelp, IconPlay, IconStop, IconUser } from "./Icons";
import { ALT, altOf } from "./modKey";
import { DebugDownload } from "./DebugDownload";
import { NEEDS_BAND, NEEDS_BAND_BETWEEN } from "./copy";
import { Graded, RightOnly } from "./Graded";
import { Slots, SlotsLocked } from "./Slots";
import { keepDebugAudio, micLog } from "@/micdebug";
import { QsoExamples, QsoGuide, QsoHelp } from "./QsoHelp";
import { PageSwitch, type Page } from "./PageSwitch";
import { LevelMeter, RecDot } from "./Record";
import {
  ChartSettingsButton,
  Check,
  ChoiceGroup,
  Section,
  SettingRow,
  SettingsBand,
  BreakInSlider,
  DEFAULT_BREAK_IN_MS,
  NoiseSlider,
  QrmSlider,
  QrnSlider,
  QsbSlider,
  SettingsPanel,
  SpeedSliders,
} from "./Controls";
import { calibrationOf, profileForSource, type Profile } from "@/io/profiles";
import type { SentWpm } from "@/timing/live";
import { useLiveCopy } from "./useLiveCopy";
import { useRecorder } from "./useRecorder";
import { HomeButton } from "./Wordmark";


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

/** The tone a station line plays at when the log kept none. */
const DEFAULT_TONE_HZ = 600;

/** The band noise's pitch when it plays on its own: the middle of the
 *  stations' tones. */
const BAND_TONE_HZ = 645;

/** The band's track: this long, then it loops, at this rate. Long enough
 *  that QRM does not repeat a QSO soon. */
const BAND_SEC = 120;
const BAND_RATE = 12000;

/** How loud the station plays, at its peak. */
const THEIR_PEAK = 0.5;

const BAND_NOISE_HELP =
  "Noise, QRN and QRM play all through the QSO, as on a radio, not only while the station sends. " +
  "They cut while you key. Through speakers, the microphone hears them, and can read QRM as your " +
  "sending; headphones or a line in keep them out.";

/** The rate a tape is made at when it holds none of your recording. */
const TAPE_RATE = 24000;

/** An over that is one plain character, other than K, R or ?: noise, not
 *  sending. A prosign alone, as <SK>, is meant. */
const NOISE_RE = /^[^KR?<]$/;

/** Whether what the decoder has read so far is you sending, which locks or
 *  grades your copy. The decoder reads a character only from a narrow tone
 *  above the level floor, so noise does not make one. A bumped paddle does:
 *  one dit or one dah. So one character counts unless it is E or T. */
function isSending(text: string): boolean {
  const chars = text.replace(/\s+/g, "");
  return chars.length >= 2 || (chars.length === 1 && chars !== "E" && chars !== "T");
}

/** How long, in seconds, the next station in a run waits for you before it
 *  calls. */
const NEXT_CALL_SEC = [2, 4] as const;

/** How near the end of the log counts as at the end, in pixels: it keeps
 *  following new lines from there. */
const END_SLACK_PX = 48;

/** Wide enough for the examples beside the log. The guide's two columns
 *  start at the same width, in base.css. */
const WIDE_QUERY = "(min-width: 1000px)";

/** Whether the window is wide enough for the examples beside the log. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE_QUERY).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(WIDE_QUERY);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

/** The lines of the log in their QSOs, in order: each QSO's number and
 *  where its lines are. */
function qsoGroups(lines: readonly { qso: number }[]): { qso: number; at: number[] }[] {
  const out: { qso: number; at: number[] }[] = [];
  lines.forEach((line, i) => {
    const last = out[out.length - 1];
    if (last && last.qso === line.qso) last.at.push(i);
    else out.push({ qso: line.qso, at: [i] });
  });
  return out;
}

/** The longest one over may run. The recording starts over at each over. */
const MAX_OVER_SEC = 600;

/** Your turn, the wait before the station answers, its answer playing, or
 *  a line you chose playing again. The microphone is read on your turn
 *  alone. */
type Phase = "listening" | "waiting" | "playing" | "replaying";

/** Where the page is, as its heading says in a word. */
type QsoState = "ready" | "sending" | "waiting" | "receiving" | "paused" | "over";
const STATE_WORDS: Record<QsoState, string> = {
  ready: "Ready",
  sending: "Sending",
  waiting: "Waiting",
  receiving: "Receiving",
  paused: "Paused",
  over: "Over",
};

type CopyMode = "strict" | "lenient";

interface Option<T> {
  readonly value: T;
  readonly label: string;
  /** What it does, in a sentence, shown under the choice while it is the one
   *  chosen. */
  readonly note?: string;
}

/** A length to choose: one of the script's, or a mix of them. */
type LengthChoice = Length | "mixed";

const LENGTHS: ReadonlyArray<Option<LengthChoice>> = [
  { value: "full", label: "Full", note: "Its report, name and QTH in one line, each sent twice." },
  { value: "short", label: "Short", note: "Its report, name and QTH in one line, each sent once." },
  { value: "pieces", label: "Piece by piece", note: "Its report, name and QTH one at a time, a line each." },
  { value: "mixed", label: "Mixed", note: "Any of these, changing from one station to the next." },
];
const LENGTH_HELP =
  "How much the station says in each line. Full sends each item twice, Short once, and " +
  "Piece by piece sends its report, name and QTH one per line. Mixed changes from one " +
  "station to the next, and from one line to the next.";

/** With Mixed, how often a station goes piece by piece. The rest mix Full
 *  and Short, over by over. */
const MIXED_PIECES = 1 / 3;

const COPY_MODES: ReadonlyArray<Option<CopyMode>> = [
  { value: "lenient", label: "Lenient", note: "Accepts your spacing and a call one letter off." },
  { value: "strict", label: "Strict", note: "Wants your set speed and the exact call." },
];
const COPY_HELP =
  "How the station reads your sending. Lenient reads it at your own spacing and takes a " +
  "call with one character wrong. Strict reads it at your speed and takes only calls sent exactly.";

const THEIR_TEXTS: ReadonlyArray<Option<TheirText>> = [
  { value: "before", label: "Whole", note: "Each line shows whole as soon as it starts." },
  { value: "sent", label: "As sent", note: "Each letter shows as it is sent." },
  { value: "hidden", label: "Blurred", note: "Each line shows blurred until the QSO ends." },
  { value: "copy", label: "Copy", note: "Type what you hear, graded when the QSO ends." },
  { value: "none", label: "Off", note: "Nothing shows until the QSO ends." },
];
const THEIR_TEXT_HELP =
  "What shows of the station's lines: whole as soon as one starts, each character as it is " +
  "sent, the same blurred, a box to type your copy in, or nothing. A change applies to the " +
  "lines already shown, and what you typed stays. All of it shows when the QSO ends.";
const COPY_INPUTS: ReadonlyArray<Option<CopyInput>> = [
  { value: "text", label: "Box", note: "Type each line in a box, as you hear it." },
  { value: "slots", label: "Slots", note: "A slot for each character." },
];
const COPY_INPUT_HELP =
  "How you copy the station's lines while they show as Copy: in one box, or in a slot for " +
  "each character. Slots show how many characters each word has, so they are the easier " +
  "way to copy.";

const REPLAY_HELP =
  "When you press Continue, the station sends its last line again before your turn.";

const BLUR_CALL_HELP =
  "While the station's text is blurred, a copy box or off, its call is blurred in the log " +
  "too, until the QSO ends.";

/** When the play buttons show. */
type Playback = "never" | "always" | "end";
const PLAYBACKS: ReadonlyArray<Option<Playback>> = [
  { value: "never", label: "Never", note: "No buttons to play lines again." },
  { value: "always", label: "Always", note: "On every line. During a QSO, they play on your turn." },
  { value: "end", label: "At end", note: "On every line once the QSO is over, with Play QSO." },
];
const PLAYBACK_HELP =
  "When the play buttons show: on each line and as Play QSO under a QSO that is over. " +
  "Always shows them on every line. During a QSO they play on your turn, before you start " +
  "sending, and the microphone is not copied while they play. At end " +
  "shows them once the QSO is over.";
const SHOW_DOWNLOAD_HELP =
  "Under a QSO that is over, Download saves it as a WAV file. With QSB, noise, QRN or QRM on, " +
  "Download clean saves it without them, and Download as heard with them.";

const DOWNLOAD_HEARD_HELP =
  "Save the QSO with the QSB, noise, QRN and QRM set now. They are made again, so they are not " +
  "the same as you heard live.";

const YOUR_TEXTS: ReadonlyArray<Option<YourText>> = [
  { value: "sent", label: "As sent", note: "Each letter shows as you send it." },
  { value: "hidden", label: "Blurred", note: "Your lines show blurred until the QSO ends." },
  { value: "none", label: "Off", note: "Nothing shows of your lines until the QSO ends." },
];
const YOUR_TEXT_HELP =
  "What shows of your own lines as you send them: each character, the same blurred, or nothing.";

const ALLOW_EDITS_HELP =
  "An Edit button beside a locked copy opens it again, so you can fix a mistake. " +
  "It locks again when you next start sending, or on Enter. Not once the QSO is over.";
const GRADE_TYPING_HELP =
  "A dot under each slot you fill says if it is right: blue if right, red if not.";

/** When a suggested reply shows. */
type Hints = "off" | "always" | "copied";
const HINTS: ReadonlyArray<Option<Hints>> = [
  { value: "off", label: "Off", note: "No suggested reply." },
  { value: "always", label: "Always", note: "A suggested reply shows on each of your turns." },
  {
    value: "copied",
    label: "Once copied",
    note: "A suggested reply shows once you copy the station's line right.",
  },
];
const HINTS_HELP =
  "A suggested reply under the log: one way to answer the station, with your details from User. " +
  "Once copied waits until your copy of the station's line is all right. " +
  "When its lines are not for copying, it shows once the line has played. " +
  "The station's call and name show as (THEIR CALL) and (THEIR NAME) until you copy them, unless its lines show.";

interface Line {
  readonly who: string;
  readonly text: string;
  /** Sent by you, as copied. */
  readonly you: boolean;
  /** Which QSO of the session it belongs to. */
  readonly qso: number;
  /** Your copy of it, for the station's overs. */
  readonly typed: string;
  /** Your copy of it in slots, one per character, for the station's overs.
   *  Absent in a log kept before slots were. */
  readonly slots?: readonly string[];
  /** Copy mode: whether you copy it in a box or in slots. Absent is a box. */
  readonly input?: CopyInput;
  /** The station text it arrived under, for the station's overs. */
  readonly mode: TheirText;
  /** Copy mode: your copy can no longer change. */
  readonly locked: boolean;
  /** The speed it was sent at: measured from your sending, when it could be,
   *  or the station's own. */
  readonly sentWpm: SentWpm | null;
  /** The tone the station sent it at, for the station's overs. Absent in a
   *  log kept before it was. */
  readonly toneHz?: number;
}

/** What a reload brings back of the session: the log and the QSO under
 *  way. Not the audio. */
interface Kept {
  readonly v: 1;
  readonly lines: Line[];
  readonly closed: number[];
  readonly finished: number | null;
  readonly qso: AnyQso;
  readonly qsoNo: number;
  readonly theirSpeed: Speed;
  readonly piecesStation: boolean;
  readonly note: string;
  /** Stopped, not paused: Start begins afresh rather than going on. */
  readonly stopped: boolean;
  /** A reply due but not yet in the log when the page went. */
  readonly pending: Pending | null;
  /** Each QSO that is over, as it ended, for its report. Absent in a log
   *  kept before there were reports. */
  readonly ends?: Readonly<Record<number, AnyQso>>;
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
    // A QSO kept before `told` was added.
    qso: isRun(k.qso as AnyQso)
      ? (k.qso as AnyQso)
      : { ...(k.qso as Qso), told: Array.isArray((k.qso as Qso).told) ? (k.qso as Qso).told : [] },
    finished,
    closed,
    stopped:
      typeof k.stopped === "boolean"
        ? k.stopped
        : finished === null && !k.lines.some((l) => l.qso === qsoNo && !closed.includes(l.qso)),
    piecesStation: k.piecesStation === true,
    pending: typeof k.pending?.reply === "string" ? k.pending : null,
    ends: typeof k.ends === "object" && k.ends !== null ? k.ends : {},
    note: typeof k.note === "string" ? k.note : "",
  };
}

/** A measured speed as the log writes it: 23 wpm, or 23/17 wpm. */
function wpmOf(s: SentWpm): string {
  return fmtSpeed({ charWpm: Math.round(s.charWpm), farnsworthWpm: Math.round(s.farnsworthWpm) });
}

const LOCK_HELP =
  "Your copy of the station's line can no longer change once you start sending. " +
  "Enter in the box locks it too.";
const LOCKED_SHOWS: ReadonlyArray<Option<LockedShows>> = [
  { value: "nothing", label: "My copy", note: "Your copy as you typed it." },
  { value: "right", label: "What I got right", note: "Your copy, each letter marked right or missed." },
  { value: "grade", label: "Graded result", note: "Your copy graded against what the station sent." },
];
const LOCKED_SHOWS_HELP =
  "What a locked copy shows before the QSO ends: your copy as typed, your copy with each " +
  "character marked right or wrong, or your copy graded against what the station sent. " +
  "The graded result shows when the QSO ends.";
const SHOW_SPEED_HELP = "Each of your lines shows the speed you sent it at.";
const SHOW_THEIR_SPEED_HELP = "Each of the station's lines shows the speed it sent it at.";

/** Enter and Escape in a copy box are not the recorder's: it listens on the
 *  document, and these keys would stop the session. Enter locks the copy,
 *  and so does Cmd+Enter, or Ctrl+Enter, as on the Copy page. */
function keepKeys(ev: React.KeyboardEvent, lock: () => void): void {
  if (ev.key === "Enter" || ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
  }
  if (ev.key === "Enter") lock();
}

/** An on or off setting kept as a preference, with its default. */
function useOnOff(
  key:
    | "qsoSettingsOpen"
    | "qsoLockCopy"
    | "qsoShowSpeed"
    | "qsoShowTheirSpeed"
    | "qsoBlurCall"
    | "qsoReplay"
    | "qsoShowDownload"
    | "qsoSideGuide"
    | "qsoGradeTyping"
    | "qsoAllowEdits"
    | "qsoBandNoise",
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
  /** Back to the start screen. */
  onHome(): void;
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
  onHome,
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
  const [copyInput, setCopyInputRaw] = useState<CopyInput>(() => loadPrefs().qsoCopyInput ?? "text");
  /** For the timer that adds the station's over to the log. */
  const copyInputRef = useRef(copyInput);
  copyInputRef.current = copyInput;
  /** A change applies to the lines you are still copying. A locked copy
   *  keeps the way it was made. */
  const setCopyInput = (next: CopyInput) => {
    setCopyInputRaw(next);
    savePrefs({ ...loadPrefs(), qsoCopyInput: next });
    setLines((l) =>
      l.map((line) => (!line.you && line.mode === "copy" && !line.locked ? { ...line, input: next } : line)),
    );
  };
  /** The kind of QSO the guide's examples show. A first suggested CQ is for
   *  it. */
  const [guideKind, setGuideKind] = useState<GuideId>(() => loadPrefs().qsoGuide ?? "cq");
  const [hints, setHintsRaw] = useState<Hints>(() => loadPrefs().qsoHints ?? "off");
  const setHints = (next: Hints) => {
    setHintsRaw(next);
    savePrefs({ ...loadPrefs(), qsoHints: next });
  };
  const [yourText, setYourTextRaw] = useState<YourText>(() => loadPrefs().qsoYourText ?? "sent");
  const setYourText = (next: YourText) => {
    setYourTextRaw(next);
    savePrefs({ ...loadPrefs(), qsoYourText: next });
  };
  const [settingsOpen, setSettingsOpen] = useOnOff("qsoSettingsOpen", false);
  const [blurCall, setBlurCall] = useOnOff("qsoBlurCall", false);
  const [replayOnContinue, setReplayOnContinue] = useOnOff("qsoReplay", true);
  const [showDownload, setShowDownload] = useOnOff("qsoShowDownload", true);
  const [playback, setPlaybackRaw] = useState<Playback>(() => loadPrefs().qsoPlayback ?? "always");
  const setPlayback = (next: Playback) => {
    setPlaybackRaw(next);
    savePrefs({ ...loadPrefs(), qsoPlayback: next });
  };
  const [lockCopy, setLockCopy] = useOnOff("qsoLockCopy", true);
  const [gradeTyping, setGradeTyping] = useOnOff("qsoGradeTyping", false);
  const [allowEdits, setAllowEdits] = useOnOff("qsoAllowEdits", false);
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
  /** The examples beside the log, chosen with the ?. Only where there is
   *  room: on a narrow screen the ? opens the guide over the page. */
  const [sideGuide, setSideGuide] = useOnOff("qsoSideGuide", false);
  const wide = useWide();
  /** The log's scroll box. It keeps the newest line in view, unless you
   *  have scrolled up to read. */
  const logBox = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const qso = useRef<AnyQso>(kept?.qso ?? newQso(Math.random, "", speed));
  /** Which QSO of the session is running, counted from 0. */
  const qsoNo = useRef(kept?.qsoNo ?? 0);
  /** The QSOs that are over. Their overs all show. */
  const [closed, setClosed] = useState<readonly number[]>(() => kept?.closed ?? []);
  /** Each QSO that is over, as it ended, for its report. */
  const [ends, setEnds] = useState<Readonly<Record<number, AnyQso>>>(() => kept?.ends ?? {});
  /** A QSO that ends once the reply now playing ends. */
  const closing = useRef<number | null>(null);
  /** A QSO that has ended with your copy not yet graded. It closes when you
   *  start your next over, press Stop or ask for the grade. */
  const [finished, setFinished] = useState<number | null>(() => kept?.finished ?? null);
  /** The session was stopped, not paused: Start begins afresh. */
  const [stopped, setStopped] = useState(() => kept?.stopped ?? true);
  /** Pause, not Stop, is ending the session now. */
  const pausing = useRef(false);
  /** The end of a QSO, not Stop, is ending the session now. */
  const ending = useRef(false);
  /** Continue was pressed with Replay on Continue on: once the microphone
   *  is open, the station's last over plays again. */
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

  /* Playing a line or a whole QSO again, once the microphone is off. A player
     of its own: the one above moves the QSO on when a line ends. */
  const [replaying, setReplaying] = useState<string | null>(null);
  /** What happens when a line played again ends. */
  const replayEnded = useRef<() => void>(() => {});
  const listen = useMemo(
    () =>
      createPlayer({
        onEnded: () => {
          setReplaying(null);
          replayEnded.current();
        },
      }),
    [],
  );
  useEffect(() => () => listen.destroy(), [listen]);
  /** Your overs as recorded, by line, with the wait before each cut. Kept
   *  in the browser too, so a reload can still play them. */
  const yourAudio = useRef(new Map<number, Clip>());
  /** Bumped when the overs kept come back after a reload, to show them. */
  const [, setOversBack] = useState(0);
  useEffect(() => {
    // No log came back, so any overs kept belong to nothing.
    if (!kept) {
      void forgetQsoOvers();
      return;
    }
    let live = true;
    void recallQsoOvers().then((overs) => {
      if (!live || overs.size === 0) return;
      for (const [line, clip] of overs) if (!yourAudio.current.has(line)) yourAudio.current.set(line, clip);
      setOversBack((n) => n + 1);
    });
    return () => {
      live = false;
    };
    // Once, for the log the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* How loud the station plays: the practice page's listening level, kept in
     the same preference. */
  const [gainDb, setGainDbRaw] = useState(() => loadPrefs().gainDb ?? 0);
  const setGainDb = (next: number) => {
    setGainDbRaw(next);
    savePrefs({ ...loadPrefs(), gainDb: next });
  };
  useEffect(() => player.setGainDb(gainDb), [player, gainDb]);
  useEffect(() => listen.setGainDb(gainDb), [listen, gainDb]);

  /* QSB on the station, and the band noise under it. The same preferences
     as the Copy page's. */
  const [qsbDb, setQsbDbRaw] = useState(() => loadPrefs().qsbDb ?? 0);
  const setQsbDb = (next: number) => {
    setQsbDbRaw(next);
    savePrefs({ ...loadPrefs(), qsbDb: next });
  };
  /** Each station's fading, by call and depth, so its next over fades on
   *  from where the last one was. */
  const fades = useRef(new Map<string, Fade>());
  const fadeFor = (call: string): Fade => {
    const key = `${call}|${qsbDb}`;
    let fade = fades.current.get(key);
    if (!fade) fades.current.set(key, (fade = fadeOf(qsbDb, seedOf(call))));
    return fade;
  };
  const [noiseDb, setNoiseDbRaw] = useState(() => loadPrefs().noiseDb ?? NOISE_OFF_DB);
  const setNoiseDb = (next: number) => {
    setNoiseDbRaw(next);
    savePrefs({ ...loadPrefs(), noiseDb: next });
  };
  const [qrn, setQrnRaw] = useState(() => loadPrefs().qrn ?? 0);
  const setQrn = (next: number) => {
    setQrnRaw(next);
    savePrefs({ ...loadPrefs(), qrn: next });
  };
  const [qrmDb, setQrmDbRaw] = useState(() => loadPrefs().qrmDb ?? QRM_OFF_DB);
  const setQrmDb = (next: number) => {
    setQrmDbRaw(next);
    savePrefs({ ...loadPrefs(), qrmDb: next });
  };
  const [bandNoise, setBandNoise] = useOnOff("qsoBandNoise", true);
  const [breakInMs, setBreakInMsRaw] = useState(() => loadPrefs().qsoBreakInMs ?? DEFAULT_BREAK_IN_MS);
  const setBreakInMs = (next: number) => {
    setBreakInMsRaw(next);
    savePrefs({ ...loadPrefs(), qsoBreakInMs: next });
  };
  const hasBand = anyBand({ noiseDb, qrn, qrmDb });
  /** The band as one track, made again when a setting changes. */
  const band = useMemo<Band | null>(
    () =>
      hasBand
        ? {
            samples: bandAudio({
              n: BAND_SEC * BAND_RATE,
              rate: BAND_RATE,
              toneHz: BAND_TONE_HZ,
              peak: THEIR_PEAK,
              noiseDb,
              qrn,
              qrmDb,
              qsbDb,
              seed: Math.floor(Math.random() * 2 ** 31),
              qrmLines,
            }),
            rate: BAND_RATE,
          }
        : null,
    [hasBand, noiseDb, qrn, qrmDb, qsbDb],
  );

  /** The next station in a run, about to call. */
  const nextCall = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quiet = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (nextCall.current !== null) clearTimeout(nextCall.current);
    nextCall.current = null;
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

  /* The band noise on its own, all through a session, when asked for. */
  /* Played by the recorder, which cuts it the moment you key: see BandGate. */
  const gate = recorder?.band ?? null;
  const bandOn = bandNoise && band !== null && gate !== null;
  useEffect(() => gate?.set(bandOn ? band : null), [gate, bandOn, band]);
  useEffect(() => gate?.level(Math.pow(10, gainDb / 20)), [gate, gainDb]);
  useEffect(() => gate?.arm(phase === "listening"), [gate, phase]);
  useEffect(() => gate?.delay(breakInMs / 1000), [gate, breakInMs]);

  // Stopping the session stops the reply too, and ends the QSO. Not on
  // the first render: a QSO a reload brought back stays open to go on with.
  const hadRecorder = useRef(false);
  useEffect(() => {
    if (recorder) {
      hadRecorder.current = true;
      micLog("qso: session", {
        rate: recorder.rate,
        speed,
        copy: copyMode,
        length,
        deviceId: deviceId ? `${deviceId.slice(0, 8)}…` : "(default input)",
        calibration: profiles.find((p) => p.id === profileId)?.nickname ?? "(none)",
        applied: calibration,
      });
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
    // Stopped because the QSO ended: it is closed already, or waits for your
    // copy.
    if (ending.current) {
      ending.current = false;
      return;
    }
    // Stopped mid-QSO: its report is of the QSO as far as it went.
    const now = qso.current;
    const n = qsoNo.current;
    setEnds((e) => (e[n] ? e : { ...e, [n]: now }));
    close(n);
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
  /* The words your next over may hold, to read your spacing by: yours from
     User, and the station's call and name. */
  const user = loadUser();
  const them = qso.current.them;
  const words = useMemo(
    () => vocabulary([user.callsign, user.name, user.qthCity, user.qthRegionShort, user.cwopsNumber, them.call, them.name]),
    [user.callsign, user.name, user.qthCity, user.qthRegionShort, user.cwopsNumber, them.call, them.name],
  );
  const copy = useLiveCopy(source, phase === "listening", lenient, calibration, words);
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
      // A new station has not sent yet, so no speed of its own shows. Its
      // first over sets it.
      if (!qso.current.last) setTheirSpeed(speed);
      // The last over of a QSO in a run has played: the QSO is over, and the
      // run goes on.
      if (closing.current !== null && isRun(qso.current)) {
        const n = closing.current;
        closing.current = null;
        endInRun(n);
        return;
      }
      // The last over has played: now the QSO is over, and the session stops,
      // so it can be played back. With copy to grade, it waits for you to
      // finish typing.
      if (closing.current !== null) {
        const n = closing.current;
        closing.current = null;
        if (lines.some((l) => l.qso === n && !l.you && l.mode === "copy")) {
          setFinished(n);
          setNote("Finish your copy.");
        } else {
          close(n);
          setNote("");
        }
        ending.current = true;
        void rec.discard();
        return;
      }
      recorder?.restart();
      setPhase("listening");
    }, AFTER_REPLY_MS);
  };

  /** QSO `n` of a run is over. Its copy is graded now, or when you start
   *  your next over if there is copy to finish. You go on sending, and the
   *  next station calls in a few seconds unless you send first. */
  const endInRun = (n: number) => {
    if (lines.some((l) => l.qso === n && !l.you && l.mode === "copy")) setFinished(n);
    else close(n);
    setNote("");
    recorder?.restart();
    setPhase("listening");
    waitForNext();
  };

  /** In a run between QSOs, the next station calls in a few seconds unless
   *  you send first. */
  const waitForNext = () => {
    const [lo, hi] = NEXT_CALL_SEC;
    if (nextCall.current !== null) clearTimeout(nextCall.current);
    nextCall.current = setTimeout(
      () => {
        nextCall.current = null;
        callNext.current();
      },
      (lo + Math.random() * (hi - lo)) * 1000,
    );
  };

  /** The next station in a run calls, if you have not begun to send. */
  const callNext = useRef<() => void>(() => {});
  callNext.current = () => {
    const now = qso.current;
    if (!recorder || phase !== "listening" || !isRun(now) || now.stage !== "waiting") return;
    if (isSending(copy.text)) return;
    const turn = callIn(now);
    qso.current = turn.qso;
    // The QSO before is done with: its copy is graded, and its report shows.
    if (finishedRef.current !== null) close(finishedRef.current);
    setNote("");
    sendReply(turn.reply!, turn.qso.them, turn.qso.speed, qsoNo.current, null);
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
              slots: [],
              input: copyInputRef.current,
              mode: theirMode.current,
              locked: false,
              sentWpm: at,
              toneHz: them.toneHz,
            },
          ]);
        }
        setTheirSpeed(at);
        player.playTarget(timeline, {
          peak: THEIR_PEAK,
          padSec: 0.1,
          voice: { toneHz: them.toneHz, filterQ: 3 },
          air: {
            // On the page's clock, so the fading runs on between overs.
            ...(qsbDb > 0 ? { fade: { fade: fadeFor(them.call), atSec: performance.now() / 1000 } } : {}),
            // With the over, unless the band already plays it.
            ...(band && !bandOn ? { band } : {}),
          },
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

  /* You have begun sending: see `isSending`. Only characters read back, not
     one still being keyed. */
  const sending =
    phase === "listening" &&
    copy.turn !== answered.current &&
    isSending(copy.text);


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
    // The over as the decoder had it, kept for the debug download.
    {
      const audio = recorder.since(0);
      keepDebugAudio(`over ${qsoNo.current}: ${heard || "(nothing)"}`, audio, recorder.rate);
      micLog("qso: over", {
        heard,
        sentWpm: copy.sentWpm,
        seconds: Number((audio.length / recorder.rate).toFixed(2)),
        // The same over at each step: recorded, read, sent to the decoder,
        // dropped while the station played, and received by the decoder.
        recorded: audio.length,
        ...copy.flow,
        lenient,
        speed,
      });
    }
    // One character alone is noise on the line, a click or a bump of the key,
    // not a turn. Not answered, and the turn starts over. K, R and ? alone
    // are answers, so they still count.
    if (NOISE_RE.test(heard)) {
      recorder.restart();
      return;
    }
    const user = loadUser();
    const turn = respond(qso.current, heard, {
      ear: { lenient, saved: user.callsign },
      region: user.qthRegionShort,
      speed,
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

    qso.current = turn.ended ? following(turn.qso, Math.random, speed) : turn.qso;
    if (turn.ended) {
      const done = turn.qso;
      setEnds((e) => ({ ...e, [n]: done }));
      qsoNo.current++;
      piecesStation.current = Math.random() < MIXED_PIECES;
    }
    const at = turn.qso.speed;
    const clip = trimmed({ samples: recorder.since(0), rate: recorder.rate });
    setLines((l) => {
      yourAudio.current.set(l.length, clip);
      void keepQsoOver(l.length, clip.samples, clip.rate);
      return [...l, sent];
    });

    if (turn.reply === null) {
      // Your TU ended a QSO in a run, and the station sends nothing back.
      if (turn.ended) {
        endInRun(n);
        return;
      }
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
    yourAudio.current.clear();
    void forgetQsoOvers();
    setNote("");
    setClosed([]);
    setEnds({});
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
    listen.stop();
    player.wake();
    replayOnStart.current = false;
    freshOnStart.current = true;
    setStarting(true);
    void rec.start().finally(() => setStarting(false));
  };

  /** Clear the log while no session runs: the page goes back to the guide. */
  const clear = () => {
    listen.stop();
    pending.current = null;
    fresh.current();
    setStopped(true);
  };

  /** Go on with the QSO a reload brought back: the log and the QSO stay. */
  const resume = () => {
    listen.stop();
    player.wake();
    freshOnStart.current = false;
    setStarting(true);
    setStopped(false);
    setPlaying(null);
    answered.current = -1;
    // A reply still due goes out either way. The setting is for the last
    // over, already in the log.
    replayOnStart.current = replayOnContinue || pending.current !== null;
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
            ends,
          },
    );
    // The phase, for a reply that is due: it is kept as soon as it is.
  }, [lines, closed, finished, theirSpeed, note, stopped, phase, ends]);

  /** Paused, or a reload came back to a session under way: Continue goes
   *  on with it, where Start would clear the log. */
  const open = !recorder && !stopped && lines.length > 0;
  goRef.current = open ? resume : start;

  const setTyped = (at: number, typed: string) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, typed } : line)));
  const setSlots = (at: number, slots: string[]) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, slots } : line)));
  const lock = (at: number) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, locked: true } : line)));
  /** Open a locked copy again, to put a mistake right. It locks again when
   *  you next start sending, or on Enter. */
  const unlock = (at: number) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, locked: false } : line)));

  /** Edit, on a locked copy of a QSO still under way. */
  const lineEdit = (line: Line, i: number): React.ReactElement | null => {
    if (!allowEdits || closed.includes(line.qso)) return null;
    // Its place kept on a line that cannot be edited, so every line's speed
    // and play button line up.
    if (line.you || !line.locked || theirModeOf(line) !== "copy") return <span className="lspace" aria-hidden="true" />;
    return (
      <button
        type="button"
        className="iconbtn qsoplay"
        data-testid="qso-line-edit"
        aria-label="Edit my copy"
        title="Edit my copy"
        onClick={() => unlock(i)}
      >
        <IconEdit />
      </button>
    );
  };

  /** Line `i` as the tape needs it, or null when its audio is gone: your
   *  over after a reload. */
  const tapeLineOf = (i: number): TapeLine | null => {
    const line = lines[i];
    if (!line) return null;
    if (line.you) {
      const clip = yourAudio.current.get(i);
      return clip ? { you: true, clip } : null;
    }
    const at = line.sentWpm ?? theirSpeed;
    return {
      you: false,
      text: line.text,
      speed: { charWpm: at.charWpm, farnsworthWpm: at.farnsworthWpm },
      toneHz: line.toneHz ?? DEFAULT_TONE_HZ,
      call: line.who,
    };
  };
  /** The rate the tape is made at: your recording's, so it is not changed. */
  const tapeRate = () => yourAudio.current.values().next().value?.rate ?? TAPE_RATE;
  /** Play `clip` as `key`, or stop it when it is the one playing. */
  /** What a replay adds, as the QSO was heard: the station's fading, and
   *  the band where it is not already looping under the session. Null with
   *  nothing to add. */
  const replayAdded = (): Added | null => {
    if (!anyAdded({ qsbDb, noiseDb, qrn, qrmDb })) return null;
    const quiet = bandOn ? { noiseDb: NOISE_OFF_DB, qrn: 0, qrmDb: QRM_OFF_DB } : { noiseDb, qrn, qrmDb };
    return { qsbDb, ...quiet, seed: Math.floor(Math.random() * 2 ** 31), qrmLines };
  };
  /** One line to play again, as it was heard. */
  const lineHeard = (part: TapeLine): Clip => {
    const added = replayAdded();
    return added ? tape([part], tapeRate(), added) : lineAudio(part, tapeRate());
  };
  const playClip = (key: string, clip: Clip) => {
    if (replaying === key) {
      listen.stop();
      return;
    }
    listen.wake();
    setReplaying(key);
    // In a session, the microphone is not read while the line plays, so the
    // line is not copied as your sending.
    if (recorder) setPhase("replaying");
    void listen.playBuffer(encodeWavBuffer(clip.samples, clip.rate));
  };
  /* The line has played: in a session, your turn starts over, clear of it.
     In a run between QSOs, the next station waits a few seconds more. */
  replayEnded.current = () => {
    if (!recorder || phase !== "replaying") return;
    recorder.restart();
    setPhase("listening");
    const now = qso.current;
    if (isRun(now) && now.stage === "waiting") waitForNext();
  };
  /** Option+R anywhere on the page, or Alt+R: the station's last line plays
   *  again, with the play buttons on every line, as Option+R plays the line
   *  again on the Copy page. */
  const replayLast = () => {
    if (playback !== "always") return;
    let i = lines.length - 1;
    while (i >= 0 && lines[i]!.you) i--;
    const part = i >= 0 ? tapeLineOf(i) : null;
    if (!part || cannotPlay() !== null) return;
    playClip(`line ${i}`, lineHeard(part));
  };
  const replayKey = useRef(replayLast);
  replayKey.current = replayLast;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code !== "KeyR" || ev.repeat || !altOf(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      replayKey.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  /** Why a line cannot play now, or null when it can. In a session, it plays
   *  on your turn before you start sending. */
  const cannotPlay = (): string | null => {
    if (!recorder || replaying !== null) return null;
    if (phase !== "listening") return "Plays on your turn";
    if (sending) return "Plays before you start sending";
    return null;
  };
  /** The lines of QSO `n`, as the tape needs them, or null when any of their
   *  audio is gone. Cheap: the tape itself is made on a click. */
  const qsoParts = (n: number): TapeLine[] | null => {
    const parts: TapeLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.qso !== n) continue;
      const part = tapeLineOf(i);
      if (!part) return null;
      parts.push(part);
    }
    return parts.length ? parts : null;
  };
  /** Save QSO `n` as a WAV file named for the station, and as heard when
   *  `heard`. */
  const download = (n: number, clip: Clip, heard = false) => {
    const who = lines.find((l) => l.qso === n && !l.you)?.who ?? "qso";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(encodeWav(clip.samples, clip.rate));
    a.download = `qso-${who.toLowerCase()}-${new Date().toISOString().slice(0, 10)}${heard ? "-as-heard" : ""}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  /** The play button at the end of line `i`. Off while the microphone is
   *  on, and for an over whose recording is gone. */
  const linePlay = (i: number): React.ReactElement | null => {
    if (playback === "never") return null;
    if (playback === "end" && !closed.includes(lines[i]!.qso)) return null;
    const part = tapeLineOf(i);
    const key = `line ${i}`;
    const on = replaying === key;
    const why = part ? cannotPlay() : "This over's recording was not kept";
    return (
      <button
        type="button"
        className="iconbtn qsoplay"
        data-testid="qso-line-play"
        disabled={why !== null}
        aria-label={on ? "Stop" : "Play this line"}
        title={why ?? (on ? "Stop" : "Play this line")}
        onClick={() => part && playClip(key, lineHeard(part))}
      >
        {on ? <IconStop /> : <IconPlay />}
      </button>
    );
  };

  /** Play QSO and Download, under the last line of QSO `n` once it is over. */
  /** Under a QSO that is over: each item of the exchange as one side sent
   *  it and the other copied it, with what went wrong marked. */
  const qsoReport = (n: number): React.ReactElement | null => {
    const done = ends[n];
    if (!closed.includes(n) || !done) return null;
    const theirLines = lines.filter((l) => l.qso === n && !l.you);
    if (theirLines.length === 0) return null;
    const user = loadUser();
    const city = user.qthCity.trim();
    const region = user.qthRegionShort.trim();
    const rows = exchangeReport(
      done,
      theirLines.map((l) => ({ text: l.text, typed: l.mode === "copy" ? typedOf(l) : null })),
      {
        call: user.callsign.trim(),
        name: user.name.trim(),
        qth: [city, region].filter(Boolean).join(" "),
        region,
        nr: user.cwopsNumber.trim(),
      },
    );
    const call = done.them.call;
    const group = (from: "them" | "you", sent: string, copied: string) => (
      <>
        <tr className="side">
          <th scope="col" />
          <th scope="col">{sent}</th>
          <th scope="col">{copied}</th>
        </tr>
        {rows
          .filter((r) => r.from === from)
          .map((r) => (
            <tr key={`${from} ${r.label}`} className={r.ok === false ? "bad" : undefined} data-ok={String(r.ok)}>
              <th scope="row">{r.label}</th>
              <td>{r.sent || "—"}</td>
              <td>{r.copied === null ? "—" : r.copied || "(missed)"}</td>
            </tr>
          ))}
      </>
    );
    return (
      <div className="qsoreport" data-testid="qso-report">
        <table>
          <tbody>
            {group("them", `${call} sent`, "You copied")}
            {group("you", "You sent", `${call} copied`)}
          </tbody>
        </table>
      </div>
    );
  };
  const qsoTapeRow = (n: number): React.ReactElement | null => {
    if (!closed.includes(n)) return null;
    const play = playback !== "never";
    if (!play && !showDownload) return null;
    // The row shows while your overs come back after a reload, so the log
    // does not move when they do.
    const parts = qsoParts(n);
    const make = () => tape(parts!, tapeRate());
    /** As heard: the station's fading and the band, made again. */
    const heard = (): Clip =>
      tape(parts!, tapeRate(), { qsbDb, noiseDb, qrn, qrmDb, seed: Math.floor(Math.random() * 2 ** 31), qrmLines });
    const added = anyAdded({ qsbDb, noiseDb, qrn, qrmDb });
    const gone = parts ? null : "This QSO's recording was not kept";
    const why = gone ?? cannotPlay();
    /** A play button: clean, or as heard with all that is added. */
    const playButton = (asHeard: boolean, label: string, testId: string) => {
      const key = `qso ${n}${asHeard ? " heard" : ""}`;
      const on = replaying === key;
      return (
        <button
          type="button"
          data-testid={testId}
          disabled={why !== null}
          title={why ?? undefined}
          onClick={() => playClip(key, asHeard ? tape(parts!, tapeRate(), replayAdded() ?? undefined) : make())}
        >
          <i className="ico">{on ? <IconStop /> : <IconPlay />}</i>
          {on ? "Stop" : label}
        </button>
      );
    };
    return (
      <li className="qsotape" data-testid="qso-tape">
        {play && !added && playButton(false, "Play QSO", "qso-play")}
        {play && added && playButton(false, "Play clean", "qso-play")}
        {play && added && playButton(true, "Play as heard", "qso-play-heard")}
        {showDownload && (
          <button
            type="button"
            data-testid="qso-download"
            disabled={gone !== null}
            title={gone ?? undefined}
            onClick={() => download(n, make())}
          >
            <i className="ico">
              <IconDownload />
            </i>
            {added ? "Download clean" : "Download"}
          </button>
        )}
        {showDownload && added && (
          <button
            type="button"
            data-testid="qso-download-heard"
            disabled={gone !== null}
            title={gone ?? DOWNLOAD_HEARD_HELP}
            onClick={() => download(n, heard(), true)}
          >
            <i className="ico">
              <IconDownload />
            </i>
            Download as heard
          </button>
        )}
      </li>
    );
  };

  /** How one of the station's overs shows. Every choice applies to the
   *  overs already shown, but Copy: switched on mid-QSO, it does not turn
   *  overs already read into boxes. An over that arrived under Copy keeps
   *  what you typed whatever shows, and shows it again under Copy, locked
   *  if it was. */
  const theirModeOf = (line: Line): TheirText => {
    if (theirText !== "copy") return theirText;
    return line.mode === "copy" ? "copy" : line.mode;
  };

  /** One of the station's lines as an over, each character where it falls
   *  at the speed it was sent. */
  const overOf = (line: Line): Over => {
    const at = line.sentWpm ?? theirSpeed;
    return overOfText(line.text, at.charWpm, at.farnsworthWpm);
  };
  /** Your copy of one of the station's lines, as the slots take it: a slot
   *  for each character of `over`. */
  const lineCopyOf = (line: Line, over: Over): LineCopy => ({
    typed: line.typed,
    slots: charsOf(over).map((_, i) => line.slots?.[i] ?? ""),
    locked: line.locked,
    kept: null,
  });
  /** Your copy of one of the station's lines as text: the box, or the slots. */
  const typedOf = (line: Line): string => {
    if (line.input !== "slots") return line.typed;
    const over = overOf(line);
    return copyText(over, lineCopyOf(line, over), "slots");
  };

  /** Whether you have the station's call in QSO `n`: the exact call in one
   *  of your overs as copied, or in your copy of one of its overs. */
  const identified = (n: number, call: string): boolean =>
    lines.some(
      (l) =>
        l.qso === n &&
        (l.you ? l.text : typedOf(l)).toUpperCase().replace(/\s+/g, "").includes(call),
    );

  /** Whether you have the word `word` in QSO `n`: in one of your overs as
   *  copied, or in your copy of one of the station's overs. A whole word,
   *  so ED is not in RED. */
  const heard = (n: number, word: string): boolean =>
    lines.some(
      (l) => l.qso === n && (l.you ? l.text : typedOf(l)).toUpperCase().split(/\s+/).includes(word),
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
    const sent = !line.you && line.mode === "copy" && line.input === "slots" ? overOf(line) : null;
    // The grade is the record of a copy: it stays, whatever shows now.
    if (over && !line.you && line.mode === "copy") {
      if (sent) return <SlotsLocked over={sent} copy={lineCopyOf(line, sent)} marks sent />;
      return <Graded sent={line.text} typed={line.typed} />;
    }
    if (over || mode === "before") {
      return <span className="text">{line.text || "(nothing copied)"}</span>;
    }
    if (mode === "none") return <span className="text off">not shown</span>;
    if (mode === "copy" && sent) {
      if (line.locked) {
        return (
          <SlotsLocked
            over={sent}
            copy={lineCopyOf(line, sent)}
            marks={lockedShows !== "nothing"}
            sent={lockedShows === "grade"}
          />
        );
      }
      return (
        <Slots
          over={sent}
          copy={lineCopyOf(line, sent)}
          label={whoOf(line)}
          onSlots={(next) => setSlots(at, next)}
          onLock={() => lock(at)}
          grade={gradeTyping}
          onKey={typed}
        />
      );
    }
    if (mode === "copy" && line.locked) {
      if (lockedShows === "grade") return <Graded sent={line.text} typed={line.typed} />;
      if (lockedShows === "right") return <RightOnly sent={line.text} typed={line.typed} />;
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

  /* A suggested reply, on your turn. Once copied, it waits for your copy of
     the station's last line to be all right. A line not for copying has
     played by the time it is your turn. */
  const lastTheirs = [...lines].reverse().find((l) => l.qso === qsoNo.current && !l.you);
  const copiedRight = (): boolean => {
    if (!lastTheirs || theirModeOf(lastTheirs) !== "copy") return true;
    const grade = gradeCopy(lastTheirs.text, typedOf(lastTheirs));
    return grade.right === grade.total;
  };
  /* The station's call and name go in the reply once you have each, or once
     one of its lines shows its text. Until then, (THEIR CALL), (THEIR NAME). */
  const theirsShown = lines.some(
    (l) => l.qso === qsoNo.current && !l.you && ["before", "sent"].includes(theirModeOf(l)),
  );
  const callShown = theirsShown || identified(qsoNo.current, them.call);
  const nameShown = theirsShown || heard(qsoNo.current, them.name);
  const suggestion =
    recorder && phase === "listening" && (hints === "always" || (hints === "copied" && copiedRight()))
      ? hint(
          qso.current,
          meOf(loadUser()),
          guideKind === "cq" ? null : guideKind,
          seededVoice(qsoNo.current * 1000 + lines.length, new Date().getHours()),
          { call: callShown ? them.call : THEIR_CALL, name: nameShown ? them.name : THEIR_NAME },
        )
      : null;

  /* A new line, or more of one, keeps the end of the log in view: unless you
     scrolled up, in which case the log stays where you are reading. */
  useLayoutEffect(() => {
    const box = logBox.current;
    if (box && atEnd.current) box.scrollTop = box.scrollHeight;
  }, [lines, playing, copy.text, note, finished, suggestion]);

  const status = !recorder
    ? open
      ? "Press Continue to go on, or Restart for a new QSO."
      : lines.length > 0
        ? "Press Start for a new QSO."
        : "Press Start, then call CQ."
    : phase === "listening"
      ? qso.current.stage === "cq"
        ? "Call CQ to make a contact."
        : qso.current.stage === "waiting"
          ? "Call CQ, or wait for the next station."
          : "Send your reply to the station."
      : phase === "waiting"
        ? "The station is about to answer."
        : theirText === "copy"
          ? "Type what you hear."
          : "Listen to the station.";

  /** The format of the run under way, for the guide to show. */
  const runFormat = isRun(qso.current) ? qso.current.format : undefined;
  const side = sideGuide && wide && !guideShown;

  /* A run under way: its format, the QSOs made, and in an MST the serial
     number you send next. */
  const run = isRun(qso.current) && lines.length > 0 ? qso.current : null;
  const tally = run
    ? `${FORMATS[run.format].word}: ${run.made} ${run.made === 1 ? "QSO" : "QSOs"}` +
      (run.format === "mst" ? `. Your next number is ${run.made + 1}.` : "")
    : null;

  /** Where things are, in a word, beside the sentence that says what to do,
   *  as the Copy page shows it. */
  const state: QsoState = !recorder
    ? open
      ? "paused"
      : lines.length > 0
        ? "over"
        : "ready"
    : phase === "listening"
      ? "sending"
      : phase === "waiting"
        ? "waiting"
        : "receiving";

  return (
    <>
      <header>
        <HomeButton onHome={onHome} disabled={recorder !== null} />
        <PageSwitch page="qso" onPage={onPage} disabled={recorder !== null} />
        {/* Always here, as on the other pages. Off while a session runs or
            with nothing in the log. */}
        <button
          data-testid="qso-clear"
          disabled={recorder !== null || starting || lines.length === 0}
          title="Clear the log of every QSO"
          onClick={clear}
        >
          Clear
        </button>
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
          className="formpanel qsopanel"
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
          audioExtra={
            <>
              <QsbSlider qsbDb={qsbDb} onChange={setQsbDb} />
              <NoiseSlider noiseDb={noiseDb} onChange={setNoiseDb} />
              <QrnSlider qrn={qrn} onChange={setQrn} />
              <QrmSlider qrmDb={qrmDb} onChange={setQrmDb} />
              <BreakInSlider
                ms={breakInMs}
                barred={!hasBand ? NEEDS_BAND : !bandNoise ? NEEDS_BAND_BETWEEN : null}
                onChange={setBreakInMs}
              />
              <SettingRow label="Between its lines">
                <Check
                  id="qso-band-noise"
                  label="Play the band"
                  help={BAND_NOISE_HELP}
                  barred={hasBand ? null : NEEDS_BAND}
                  checked={bandNoise}
                  onChange={setBandNoise}
                />
              </SettingRow>
            </>
          }
          /* What is set for this page alone, under the audio and the speed,
             which both pages share. Grouped by what each is about: the
             station, you, and what comes after a QSO. */
          pageRow={
            <>
              <Section name="station" title="The other station">
                <div className="panelgroups">
                  <ChoiceGroup
                    id="qso-length"
                    label="How much it sends"
                    help={LENGTH_HELP}
                    value={length}
                    options={LENGTHS}
                    onChange={(v) => setLength(v as LengthChoice)}
                  />
                  <ChoiceGroup
                    id="qso-their-text"
                    label="Its lines show"
                    help={THEIR_TEXT_HELP}
                    value={theirText}
                    options={THEIR_TEXTS}
                    onChange={(v) => setTheirText(v as TheirText)}
                  />
                  <ChoiceGroup
                    id="qso-copy-input"
                    label="Enter copy as"
                    help={COPY_INPUT_HELP}
                    value={copyInput}
                    options={COPY_INPUTS}
                    onChange={(v) => setCopyInput(v as CopyInput)}
                  />
                  <Check
                    id="qso-grade-typing"
                    label="Grade slots as I type"
                    help={GRADE_TYPING_HELP}
                    checked={gradeTyping}
                    onChange={setGradeTyping}
                  />
                  <Check
                    id="qso-blur-call"
                    label="Hide its call while I copy"
                    help={BLUR_CALL_HELP}
                    checked={blurCall}
                    onChange={setBlurCall}
                  />
                  <Check
                    id="qso-show-their-speed"
                    label="Show its speed on each line"
                    help={SHOW_THEIR_SPEED_HELP}
                    checked={showTheirSpeed}
                    onChange={setShowTheirSpeed}
                  />
                  <SettingRow label="When I start sending">
                    <Check
                      id="qso-lock-copy"
                      label="Lock my copy"
                      help={LOCK_HELP}
                      checked={lockCopy}
                      onChange={setLockCopy}
                    />
                  </SettingRow>
                  <ChoiceGroup
                    id="qso-locked-shows"
                    label="My locked copy shows"
                    help={LOCKED_SHOWS_HELP}
                    value={lockedShows}
                    options={LOCKED_SHOWS}
                    onChange={(v) => setLockedShows(v as LockedShows)}
                  />
                  <Check
                    id="qso-allow-edits"
                    label="Allow edits"
                    help={ALLOW_EDITS_HELP}
                    checked={allowEdits}
                    onChange={setAllowEdits}
                  />
                </div>
              </Section>
              {/* You and After a QSO, one above the other beside The other
                  station, which is as tall as both. */}
              <div className="sectioncol">
                <Section name="you" title="You">
                  <div className="panelgroups">
                    <ChoiceGroup
                      id="qso-copy"
                      label="The station reads my sending"
                      help={COPY_HELP}
                      value={copyMode}
                      options={COPY_MODES}
                      onChange={(v) => setCopyMode(v as CopyMode)}
                    />
                    <ChoiceGroup
                      id="qso-your-text"
                      label="My lines show"
                      help={YOUR_TEXT_HELP}
                      value={yourText}
                      options={YOUR_TEXTS}
                      onChange={(v) => setYourText(v as YourText)}
                    />
                    <ChoiceGroup
                      id="qso-hints"
                      label="Suggest my reply"
                      help={HINTS_HELP}
                      value={hints}
                      options={HINTS}
                      onChange={(v) => setHints(v as Hints)}
                    />
                    <Check
                      id="qso-show-speed"
                      label="Show my speed on each line"
                      help={SHOW_SPEED_HELP}
                      checked={showSpeed}
                      onChange={setShowSpeed}
                    />
                  </div>
                </Section>
                <Section name="after" title="After a QSO">
                  <div className="panelgroups">
                    <ChoiceGroup
                      id="qso-playback"
                      label="Play buttons"
                      help={PLAYBACK_HELP}
                      value={playback}
                      options={PLAYBACKS}
                      onChange={(v) => setPlayback(v as Playback)}
                    />
                    <Check
                      id="qso-show-download"
                      label="Show Download, to save it as audio"
                      help={SHOW_DOWNLOAD_HELP}
                      checked={showDownload}
                      onChange={setShowDownload}
                    />
                    <SettingRow label="After a pause">
                      <Check
                        id="qso-replay"
                        label="Continue plays the station's last line again"
                        help={REPLAY_HELP}
                        checked={replayOnContinue}
                        onChange={setReplayOnContinue}
                      />
                    </SettingRow>
                  </div>
                </Section>
              </div>
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
        <QsoHelp
          initial={runFormat}
          onShown={setGuideKind}
          onClose={() => setHelpOpen(false)}
          onSettings={() => setSettingsOpen(true)}
          settingsOpen={settingsOpen}
        />
      )}

      <main className="panel qso" data-testid="qso">
        <div className="qsotop">
          <div className="copyhead" role="status" aria-live="polite">
            <span className="uplabel" data-testid="qso-state" data-state={state}>
              {STATE_WORDS[state]}
            </span>
            <span className="copysay qsostatus">{status}</span>
            {run && tally && (
              <span className="hint qsotally" data-testid="qso-tally" data-format={run.format} data-made={run.made}>
                {tally}
              </span>
            )}
          </div>

          <div className="qsocontrols">
            {rec.needAccess ? (
              <button className="primary" disabled={rec.blocked} onClick={() => void rec.grantAccess()}>
                Allow the microphone
              </button>
            ) : !recorder ? (
              <>
                <button
                  className="primary"
                  data-testid={open ? "qso-continue" : "qso-start"}
                  disabled={rec.probing || rec.blocked || rec.busy || starting}
                  onClick={open ? resume : start}
                >
                  <RecDot /> {starting ? "Starting…" : open ? "Continue" : "Start"}
                </button>
                {/* Restart clears the log and starts a new QSO with a new
                    station, as Start does when there is nothing to go on with. */}
                {open && !starting && (
                  <button
                    data-testid="qso-restart"
                    disabled={rec.probing || rec.blocked || rec.busy}
                    onClick={start}
                  >
                    Restart
                  </button>
                )}
              </>
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
            <DebugDownload
              current={() =>
                recorder
                  ? {
                      label: `in progress: ${copy.text || "(nothing)"}${copy.keying ? ` [${copy.keying}]` : ""}`,
                      samples: recorder.since(0),
                      rate: recorder.rate,
                    }
                  : null
              }
            />
            {/* Your speed does two jobs: your sending is copied at it, and each
                new station answers at it. QRS and QRQ change the station's speed
                alone. */}
            {/* Only once QRS or QRQ has moved it: a station starts at your speed,
                and the guide says so. */}
            {!same(theirSpeed, speed) && (
              <span className="hint" data-testid="qso-their-speed">
                The station sends at {fmtSpeed(theirSpeed)}.
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
                aria-pressed={wide ? side : undefined}
                onClick={() => (wide ? setSideGuide(!sideGuide) : setHelpOpen(true))}
              >
                <IconHelp />
              </button>
            )}
          </div>
        </div>

        {guideShown && (
          <div className="qsoguide prose" data-testid="qso-guide">
            <QsoGuide onSettings={() => setSettingsOpen(true)} settingsOpen={settingsOpen} onShown={setGuideKind} />
          </div>
        )}

        <div className={side ? "qsobody side" : "qsobody"}>
          <div
            className="qsomain"
            ref={logBox}
            onScroll={(e) => {
              const box = e.currentTarget;
              atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < END_SLACK_PX;
            }}
          >
            <ol className="qsolog" data-testid="qso-log">
              {/* Each QSO: its lines, and its report beside them once it is
                  over. A line divides one QSO from the next. */}
              {qsoGroups(lines).map((group, g, all) => (
                <Fragment key={group.at[0]}>
                  <li className="qsogroup">
                    <ol className="qsolines">
                      {group.at.map((i) => {
                        const line = lines[i]!;
                        return (
                          <li key={i} className={line.you ? "you" : "them"}>
                            {labelOf(line)}
                            {textOf(line, i)}
                            <span className="lend">
                              {(line.you ? showSpeed : showTheirSpeed) && line.sentWpm && (
                                <span className="lwpm" data-testid="qso-line-wpm">
                                  {wpmOf(line.sentWpm)}
                                </span>
                              )}
                              {lineEdit(line, i)}
                              {linePlay(i)}
                            </span>
                          </li>
                        );
                      })}
                      {qsoTapeRow(group.qso)}
                    </ol>
                    {qsoReport(group.qso)}
                  </li>
                  {g < all.length - 1 && <li className="qsodivider" role="separator" data-testid="qso-divider" />}
                </Fragment>
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

            {suggestion && (
              <p className="qsohint" data-testid="qso-hint">
                Suggested reply:<code>{suggestion}</code>
              </p>
            )}

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
                        setNote("");
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
                {playback === "always" && (
                  <>
                    {" "}
                    &nbsp;·&nbsp; <kbd>{ALT}</kbd> <kbd>R</kbd> play its last line again
                  </>
                )}
              </p>
            )}
          </div>
          {side && (
            <aside className="qsoside prose" data-testid="qso-side">
              {/* A new run's format shows when the run starts. */}
              <QsoExamples key={runFormat ?? "cq"} initial={runFormat} onShown={setGuideKind} />
            </aside>
          )}
        </div>
      </main>
    </>
  );
}
