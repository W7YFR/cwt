/* The Copy page: play a QSO in CW and copy it.
 *
 * Generate QSO makes a QSO: two stations, in a kind you choose, sent from
 * text, so the text is the answer key. New exchange gives the page text of
 * your own to send the same way. Or you open a recording, and the
 * decoder reads it whole before you start, and what it reads is the key. The recording plays, and each over shows as a
 * line as it starts, with a box to copy it in. A line locks when the next
 * line starts, when you copy again, or on Cmd+Enter (Ctrl+Enter off a
 * Mac), and shows what you got.
 *
 * Each try at the whole recording is an attempt. Copy again starts the next
 * one from the top, and the earlier ones can stay in view, so you see what
 * you got last time and how you are getting on.
 *
 * The recording and your attempts stay in the browser, so a reload comes
 * back to both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPlayer } from "@/audio/player";
import { NOISE_OFF_DB } from "@/audio/qsb";
import { QRM_OFF_DB } from "@/copy/band";
import { encodeWav, encodeWavBuffer } from "@/audio/wav";
import { ACCEPTED, isTextFile, loadAudioFile } from "@/capture/file";
import type { Over, Recording } from "@/copy/decode";
import { isScript, makeScript, nameOf, sendScript, timeIn, type Kind, type Script } from "@/copy/generate";
import { textScript } from "@/copy/text";
import {
  charsOf,
  clock,
  copyText,
  emptyCopy,
  gradeLine,
  heard,
  keyedOf,
  leadIn,
  nextCopy,
  overSpans,
  plain,
  sentText,
  skipSpan,
  slotsOfTyped,
  wordAt,
  wordSpans,
  type Attempt,
  type CopyInput,
  type LineCopy,
} from "@/copy/lines";
import {
  forgetCopyFile,
  keepCopyFile,
  loadPrefs,
  loadSpeed,
  loadUser,
  recallCopy,
  recallCopyFile,
  rememberCopy,
  savePrefs,
  type Prefs,
} from "@/io/storage";
import { FORMATS } from "@/qso/formats";
import { anyAdded } from "@/qso/tape";
import { fmtSpeed } from "./format";
import type { LockedShows } from "@/qso/show";
import type { Speed } from "@/qso/speed";
import type { Length } from "@/qso/wording";
import {
  ChartSettingsButton,
  Check,
  ChoiceGroup,
  Section,
  SettingRow,
  SettingsBand,
  SettingsPanel,
  NoiseSlider,
  QrmSlider,
  QrnSlider,
  QsbSlider,
  SpeedSliders,
} from "./Controls";
import { Graded, RightOnly, SentMarks, YourCopy, YourMarks, type SentAttrs } from "./Graded";
import { IconDownload, IconEdit, IconPause, IconPlay, IconStop, IconUpload, IconUser } from "./Icons";
import { CopyText } from "./CopyText";
import { PageSwitch, type Page } from "./PageSwitch";
import { isRecording, readRecording } from "./readRecording";
import { SentText, Slots, SlotsAsText, SlotsLocked, SlotsPast } from "./Slots";
import { HomeButton } from "./Wordmark";
import { ALT, MOD, modOf } from "./modKey";

/** What the page calls text pasted or typed in. */
const TEXT_TITLE = "Your text";

/** How long after the last line ends its copy locks, when Lock is on. Every
 *  other line locks when the next one starts. */
const LAST_LOCK_SEC = 5;

/** A play of part of the recording starts this much before it and ends this
 *  much after, so its first and last characters are heard whole. */
const PART_PAD_SEC = 0.15;


/** What shows of a line as it plays. */
type LinesShow = "copy" | "sent" | "before";

/** Which earlier attempts show while you copy again. */
type Earlier = "all" | "last" | "none";

interface Option<T> {
  readonly value: T;
  readonly label: string;
  readonly note?: string;
}

const INPUTS: ReadonlyArray<Option<CopyInput>> = [
  { value: "text", label: "Box", note: "Type each line in a box, as you hear it." },
  { value: "slots", label: "Slots", note: "A slot for each character." },
];
const INPUT_HELP =
  "How you copy each line: in one box, or in a slot for each character. Slots show how " +
  "many characters each word has, so they are the easier way to copy. A change during " +
  "an attempt takes effect at Copy again.";

const LINES_SHOW: ReadonlyArray<Option<LinesShow>> = [
  { value: "copy", label: "Copy", note: "Type what you hear, graded when the line locks." },
  { value: "sent", label: "As sent", note: "Each letter shows as it is sent." },
  { value: "before", label: "Whole", note: "Each line shows whole as soon as it starts." },
];
const LINES_SHOW_HELP =
  "What shows of each line as it plays: a box to type your copy in, each character as it " +
  "is sent, or the whole line as soon as it starts.";

const LOCK_HELP =
  "Your copy of a line can no longer change once the next line starts. The last line " +
  "locks 5 seconds after it ends. With this off, your copy stays open until you press " +
  `Copy again. ${MOD}+Enter in a box locks a line too.`;

const LOCKED_SHOWS: ReadonlyArray<Option<LockedShows>> = [
  { value: "nothing", label: "My copy", note: "Your copy as you typed it." },
  { value: "right", label: "What I got right", note: "Your copy, each letter marked right or missed." },
  { value: "grade", label: "Graded result", note: "Your copy graded against what was sent." },
];
const LOCKED_SHOWS_HELP =
  "What a locked line shows: your copy as typed, your copy with each character marked " +
  "right or wrong, or your copy graded against what was sent. Show answers shows what " +
  "was sent under every line.";

const ALLOW_EDITS_HELP =
  "An Edit button beside a locked copy opens it again, so you can fix a mistake. " +
  `It locks again when it plays on, or on ${MOD}+Enter.`;

const FOLLOW_HELP =
  "The slot for the character playing now is highlighted, so you can see where the audio " +
  "is in the line.";

const GRADE_TYPING_HELP =
  "A dot under each slot you fill says if it is right: blue if right, red if not.";
const SEEK_SLOT_HELP =
  "While the recording is paused, it moves to the character of the slot you select. Play " +
  "goes on from there.";

const SHOW_DOWNLOAD_HELP =
  "Under the QSO, Download saves it as a WAV file, and Download text as a text file you can open " +
  "in New exchange. With QSB, noise, QRN or QRM on a generated QSO or your own text, Download " +
  "clean saves it without them, and Download as heard with them.";

const SHOW_SPEED_HELP = "Each line of a generated QSO or your own text shows the speed it was sent at.";

const HIDE_CALLS_HELP =
  "Each station shows as Station 1 or Station 2 until you copy its call in one of your " +
  "lines. Hearing the call is part of copying.";

const EARLIERS: ReadonlyArray<Option<Earlier>> = [
  { value: "last", label: "Last", note: "Your last attempt shows over each line, and you start from it." },
  { value: "all", label: "All", note: "Every earlier attempt shows over each line, and you start from the last." },
  { value: "none", label: "None", note: "Each attempt starts clean, with nothing from before." },
];
const EARLIER_HELP =
  "What Copy again keeps in view. Last or All show your earlier copy of each line, marked " +
  "right and wrong, and each box starts with your last copy. None starts each attempt " +
  "clean. Every attempt is kept either way.";

const KINDS: ReadonlyArray<Option<Kind>> = [
  { value: "cq", label: "CQ", note: "A standard QSO: two stations swap reports, names and QTHs, then 73." },
  { value: "pota", label: "POTA", note: "A park activator works one hunter after another: reports and states." },
  { value: "sst", label: "SST", note: "A slow speed run: names and states." },
  { value: "mst", label: "MST", note: "A medium speed run: names and serial numbers." },
  { value: "cwt", label: "CWT", note: "A fast CWops run: names and CWops numbers." },
];
const KIND_HELP =
  "The kind of QSO Generate QSO makes, as on the QSO page. CQ is a standard QSO between two " +
  "stations. The others are runs: one station calls CQ and works one station after another.";

const RUN_QSOS: ReadonlyArray<Option<string>> = [
  { value: "1", label: "1" },
  { value: "3", label: "3" },
  { value: "5", label: "5" },
  { value: "10", label: "10" },
];
const RUN_QSOS_HELP = "How many stations call in a generated POTA, SST, MST or CWT run.";

const CHAT_LENGTHS: ReadonlyArray<Option<Length>> = [
  { value: "full", label: "Full", note: "Each report, name and QTH in one line, sent twice." },
  { value: "short", label: "Short", note: "Each report, name and QTH in one line, sent once." },
  { value: "pieces", label: "Piece by piece", note: "The station that answers sends its report, name and QTH a line each." },
];
const CHAT_LENGTH_HELP = "How much each station says in a generated standard QSO, as on the QSO page.";

type Gap = "1" | "2" | "3" | "5" | "wait";
const GAPS: ReadonlyArray<Option<Gap>> = [
  { value: "1", label: "1s" },
  { value: "2", label: "2s" },
  { value: "3", label: "3s" },
  { value: "5", label: "5s" },
  { value: "wait", label: "Wait", note: `It stops after each line, and goes on when you press ${MOD}+Enter in its box.` },
];
const GAP_HELP =
  "The silence between one station's line and the next. A change applies to the QSO on the page. " +
  `Wait stops after each line until you type what you heard and press ${MOD}+Enter, which locks the line ` +
  "and goes on, as Enter does once every character is copied. Play, or Enter before then, goes on " +
  "without locking it.";

/** The silence between lines with Wait, for when you play on. */
const WAIT_GAP_SEC = 1;

/** With Wait, how far past the end of its line the QSO stops, so the line's
 *  last character is heard whole. */
const HOLD_PAD_SEC = 0.2;

type SpeedChoice = "format" | "mine";
const SPEEDS: ReadonlyArray<Option<SpeedChoice>> = [
  { value: "format", label: "Format", note: "Each station at a speed of its own, in its format's range." },
  { value: "mine", label: "Mine", note: "Every station at the speeds below." },
];
const SPEED_HELP =
  "How fast a generated QSO is sent. Format: each station at its own speed, as on the air: " +
  `POTA ${FORMATS.pota.wpm.join(" to ")}, SST ${FORMATS.sst.wpm.join(" to ")}, ` +
  `MST ${FORMATS.mst.wpm.join(" to ")}, CWT ${FORMATS.cwt.wpm.join(" to ")}, and a standard QSO 15 to 25 wpm. ` +
  "Mine: every station at the sliders. Your own text is always at the sliders. A change applies to " +
  "the QSO on the page, and keeps your copy. Moving a slider chooses Mine.";

/** Where the page is, as its heading says in a word. */
type CopyState = "reading" | "none" | "playing" | "over" | "paused" | "ready";
const STATE_WORDS: Record<CopyState, string> = {
  reading: "Reading",
  none: "Nothing to copy",
  playing: "Playing",
  over: "Over",
  paused: "Paused",
  ready: "Ready",
};

/** What a reload brings back of your copy. */
interface Kept {
  readonly v: 2;
  /** Which recording it is a copy of. */
  readonly key: string;
  /** Every attempt, the one under way last. */
  readonly attempts: Attempt[];
  /** The furthest this attempt has played. Lines up to it show. */
  readonly reached: number;
  /** Where the recording was left. */
  readonly at: number;
  readonly revealed: boolean;
}

/** Which recording `rec` is, so a copy kept for another is not put on it.
 *  A generated QSO keeps its key when sent again at another speed. */
function keyOf(name: string, rec: Recording, made = false): string {
  return made ? `${name}|made|${rec.overs.length}` : `${name}|${rec.durationSec.toFixed(2)}|${rec.overs.length}`;
}

/** A fresh copy of `rec`: one attempt, copied in `input`, nothing typed and
 *  nothing played. */
function freshKept(key: string, rec: Recording, input: CopyInput): Kept {
  return { v: 2, key, attempts: [{ input, lines: rec.overs.map(emptyCopy) }], reached: 0, at: 0, revealed: false };
}

/** Whether nothing of `a` is copied yet: no line typed, filled or locked. */
function blank(a: Attempt): boolean {
  return a.lines.every((l) => !l.locked && !l.typed && !l.slots.some(Boolean));
}

/** One line as kept, checked against its over. */
function lineBack(l: Partial<LineCopy> | null | undefined, over: Over): LineCopy {
  const fresh = emptyCopy(over);
  return {
    typed: typeof l?.typed === "string" ? l.typed : "",
    slots:
      Array.isArray(l?.slots) && l.slots.length === fresh.slots.length
        ? l.slots.map((s) => (typeof s === "string" ? s : ""))
        : fresh.slots,
    locked: l?.locked === true,
    kept: Array.isArray(l?.kept) && l.kept.length === fresh.slots.length ? l.kept.map(Boolean) : null,
  };
}

/** How an attempt kept before attempts knew it was copied: in slots if any
 *  slot is filled, in the box if anything is typed, else in `or`. */
function inputOf(lines: readonly LineCopy[], or: CopyInput): CopyInput {
  if (lines.some((l) => l.slots.some(Boolean))) return "slots";
  if (lines.some((l) => l.typed)) return "text";
  return or;
}

/** Your copy as last kept, if it is of `rec`. A copy kept before attempts
 *  is its first attempt. An attempt with no input takes it from what it
 *  holds, or `input`. */
function recallKept(key: string, rec: Recording, input: CopyInput): Kept | null {
  const k = recallCopy() as
    | (Partial<Omit<Kept, "v">> & { v?: number; lines?: Partial<LineCopy>[] })
    | null;
  if (!k || k.key !== key || typeof k.reached !== "number" || typeof k.at !== "number") return null;
  const raw: (Partial<Attempt> | null | undefined)[] | null | undefined =
    k.v === 1 ? [{ lines: k.lines as LineCopy[] }] : k.v === 2 ? k.attempts : null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((a) => Array.isArray(a?.lines) && a.lines.length === rec.overs.length)) return null;
  const attempts = raw.map((a): Attempt => {
    const lines = a!.lines!.map((l, i) => lineBack(l, rec.overs[i]!));
    const known = a!.input === "text" || a!.input === "slots" ? a!.input : null;
    return { input: known ?? inputOf(lines, input), lines };
  });
  return { v: 2, key, attempts, reached: k.reached, at: k.at, revealed: k.revealed === true };
}

type OnOffKey =
  | "copySettingsOpen"
  | "copyLock"
  | "copyHideCalls"
  | "copyFollow"
  | "copyGradeTyping"
  | "copySeekSlot"
  | "copyAllowEdits"
  | "copyShowSpeed"
  | "copyShowDownload";

/** An on or off setting kept as a preference, with its default. */
function useOnOff(key: OnOffKey, or: boolean): readonly [boolean, (next: boolean) => void] {
  const [value, setRaw] = useState<boolean>(() => loadPrefs()[key] ?? or);
  const set = (next: boolean) => {
    setRaw(next);
    savePrefs({ ...loadPrefs(), [key]: next });
  };
  return [value, set];
}

/** A choice kept as a preference, with its default. */
function useChoice<
  K extends
    | "copyInput"
    | "copyLines"
    | "copyLockedShows"
    | "copyEarlier"
    | "copyKind"
    | "copyRunQsos"
    | "copyChatLength"
    | "copyGap"
    | "copySpeed"
    | "qsbDb"
    | "noiseDb"
    | "qrn"
    | "qrmDb",
>(
  key: K,
  or: NonNullable<Prefs[K]>,
): readonly [NonNullable<Prefs[K]>, (next: NonNullable<Prefs[K]>) => void] {
  const [value, setRaw] = useState<NonNullable<Prefs[K]>>(() => loadPrefs()[key] ?? or);
  const set = (next: NonNullable<Prefs[K]>) => {
    setRaw(next);
    savePrefs({ ...loadPrefs(), [key]: next });
  };
  return [value, set];
}

/** Where each character a box's grade counts is in the audio. */
function attrsOf(over: Over): SentAttrs {
  const keyed = keyedOf(over);
  return (k) => {
    const c = keyed[k];
    return c ? { "data-t0": c.t0, "data-t1": c.t1 } : {};
  };
}

/** Whether `el` is a box to copy in. */
function isBox(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && !!el.closest(".copylog");
}

export interface CopyScreenProps {
  onError(message: string): void;
  onConfigure(): void;
  onPage(page: Page): void;
  /** Back to the start screen. */
  onHome(): void;
  /** Where the app sends a file dropped on this page. */
  fileTarget: React.MutableRefObject<((file: File) => void) | null>;
}

export function CopyScreen({ onError, onConfigure, onPage, onHome, fileTarget }: CopyScreenProps): React.ReactElement {
  const [settingsOpen, setSettingsOpen] = useOnOff("copySettingsOpen", false);
  const [lock, setLock] = useOnOff("copyLock", true);
  const [hideCalls, setHideCalls] = useOnOff("copyHideCalls", true);
  const [follow, setFollow] = useOnOff("copyFollow", false);
  const [gradeTyping, setGradeTyping] = useOnOff("copyGradeTyping", false);
  const [seekSlot, setSeekSlot] = useOnOff("copySeekSlot", false);
  const [allowEdits, setAllowEdits] = useOnOff("copyAllowEdits", false);
  const [showSpeed, setShowSpeed] = useOnOff("copyShowSpeed", true);
  const [showDownload, setShowDownload] = useOnOff("copyShowDownload", true);
  /** How the next attempt copies. The attempt under way keeps its own. */
  const [inputPref, setInputPref] = useChoice("copyInput", "text");
  const [linesShow, setLinesShow] = useChoice("copyLines", "copy");
  const [lockedShows, setLockedShows] = useChoice("copyLockedShows", "right");
  const [earlier, setEarlier] = useChoice("copyEarlier", "last");
  const [kind, setKind] = useChoice("copyKind", "cq");
  const [runQsos, setRunQsos] = useChoice("copyRunQsos", 3);
  const [chatLength, setChatLength] = useChoice("copyChatLength", "full");
  const [gap, setGap] = useChoice("copyGap", "1");
  const gapSec = gap === "wait" ? WAIT_GAP_SEC : Number(gap);
  const [speedChoice, setSpeedChoice] = useChoice("copySpeed", "format");
  const [qsbDb, setQsbDb] = useChoice("qsbDb", 0);
  const [noiseDb, setNoiseDb] = useChoice("noiseDb", NOISE_OFF_DB);
  const [qrn, setQrn] = useChoice("qrn", 0);
  const [qrmDb, setQrmDb] = useChoice("qrmDb", QRM_OFF_DB);
  const [mine, setMineRaw] = useState<Speed>(() => {
    const p = loadPrefs();
    const or = loadSpeed() ?? { charWpm: 20, farnsworthWpm: 20 };
    const charWpm = p.copyCharWpm ?? or.charWpm;
    return { charWpm, farnsworthWpm: Math.min(p.copyFarnsworthWpm ?? or.farnsworthWpm, charWpm) };
  });
  /** A slider moved: every station at the sliders from now on. */
  const setMine = (patch: Partial<Speed>) => {
    const charWpm = patch.charWpm ?? mine.charWpm;
    const next = { charWpm, farnsworthWpm: Math.min(patch.farnsworthWpm ?? mine.farnsworthWpm, charWpm) };
    setMineRaw(next);
    savePrefs({ ...loadPrefs(), copyCharWpm: next.charWpm, copyFarnsworthWpm: next.farnsworthWpm });
    if (speedChoice !== "mine") setSpeedChoice("mine");
  };
  /** How a generated QSO is sent, from the settings. */
  const sending = { gapSec, speed: speedChoice === "mine" ? mine : undefined, qsbDb, noiseDb, qrn, qrmDb };
  /** How `script` is sent. Your own text has no format, so it is always at
   *  the sliders. */
  const sendingOf = (script: Script) => (script.kind === "text" ? { ...sending, speed: mine } : sending);

  /** The recording: its name, its own bytes to play, and what was read. A
   *  generated QSO has its script too. */
  const [file, setFile] = useState<{ name: string; audio: ArrayBuffer; rec: Recording; script?: Script | undefined } | null>(
    null,
  );
  /** The recording kept from before is coming back. */
  const [recalling, setRecalling] = useState(true);
  const [reading, setReading] = useState(false);
  const [kept, setKept] = useState<Kept | null>(null);
  const rec = file?.rec ?? null;
  const attempt = kept ? kept.attempts.length - 1 : 0;
  const lines = kept?.attempts[attempt]?.lines ?? [];
  /** How the attempt under way copies. */
  const input = kept?.attempts[attempt]?.input ?? inputPref;
  /** Copy in, from the settings. An attempt with nothing copied yet takes
   *  it now; one under way keeps its own, and the next attempt takes it. */
  const setInput = (next: CopyInput) => {
    setInputPref(next);
    setKept((k) => {
      const at = k ? k.attempts.length - 1 : -1;
      if (!k || at < 0 || !blank(k.attempts[at]!) || k.attempts[at]!.input === next) return k;
      return { ...k, attempts: k.attempts.map((a, i) => (i === at ? { ...a, input: next } : a)) };
    });
  };

  /** Where the recording is: where it plays from, and where it is playing. */
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  posRef.current = pos;
  /** What is playing: the recording from where it is, or one part of it. */
  const [playing, setPlaying] = useState<"main" | { from: number; to: number } | null>(null);
  const mode = useRef<"main" | "part" | null>(null);
  const [partAt, setPartAt] = useState<number | null>(null);
  /** With Wait, where the QSO playing now stops: the end of a line not yet
   *  locked. Null when it plays to the end. */
  const holdAt = useRef<number | null>(null);
  /** At the end of the recording, run once the page has rendered. */
  const atEnd = useRef<() => void>(() => {});
  /** Locks the last line a few seconds after the recording ends. */
  const lastLock = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLastLock = () => {
    if (lastLock.current !== null) clearTimeout(lastLock.current);
    lastLock.current = null;
  };
  useEffect(() => cancelLastLock, []);

  const player = useMemo(
    () =>
      createPlayer({
        onProgress: (t) => {
          if (mode.current === "main") setPos(t);
          else setPartAt(t);
        },
        onEnded: (reason) => {
          const was = mode.current;
          mode.current = null;
          setPlaying(null);
          setPartAt(null);
          const hold = holdAt.current;
          holdAt.current = null;
          if (was === "main" && reason === "done") {
            if (hold === null) atEnd.current();
            else setPos(hold);
          }
        },
        onError,
      }),
    // The player lives as long as the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => player.destroy(), [player]);

  /* How loud the recording plays: the listening level the other pages use. */
  const [gainDb, setGainDbRaw] = useState(() => loadPrefs().gainDb ?? 0);
  const setGainDb = (next: number) => {
    setGainDbRaw(next);
    savePrefs({ ...loadPrefs(), gainDb: next });
  };
  useEffect(() => player.setGainDb(gainDb), [player, gainDb]);

  /* The recording kept from before, and your copy of it. */
  useEffect(() => {
    let live = true;
    void recallCopyFile()
      .then(async (stored) => {
        if (!live || !stored || !isRecording(stored.recording)) return;
        const audio = await stored.audio.arrayBuffer();
        if (!live) return;
        const r = stored.recording;
        const script = isScript(stored.script) ? stored.script : undefined;
        const key = keyOf(stored.name, r, !!script);
        const back = recallKept(key, r, inputPref) ?? freshKept(key, r, inputPref);
        setFile({ name: stored.name, audio, rec: r, script });
        setKept(back);
        setPos(back.at);
      })
      .finally(() => {
        if (live) setRecalling(false);
      });
    return () => {
      live = false;
    };
  }, []);

  /* Keep your copy as it changes. Where the recording is, only once it
     stops: it moves every frame while it plays. */
  useEffect(() => {
    if (!kept || playing) return;
    rememberCopy({ ...kept, at: posRef.current });
  }, [kept, playing]);

  /** New exchange, in the dialog: what the box starts with, and what the
   *  page calls it. Null when the dialog is closed. */
  const [textDraft, setTextDraft] = useState<{ text: string; title: string; picks: readonly (number | null)[] } | null>(
    null,
  );
  /** New exchange: the text on the page to edit, or the text last given. */
  const editText = () => {
    const script = file?.script;
    if (script?.kind === "text") setTextDraft({ text: script.source ?? "", title: nameOf(script), picks: script.picks ?? [] });
    else {
      const p = loadPrefs();
      setTextDraft({ text: p.copyText ?? "", title: TEXT_TITLE, picks: p.copyPicks ?? [] });
    }
  };
  /** The text in the dialog, sent at the page's speed, in place of what was
   *  on the page. */
  const startText = (text: string, title: string, picks: (number | null)[]) => {
    const script = textScript(text, { title, picks, speed: mine, user: loadUser() });
    savePrefs({ ...loadPrefs(), copyText: text, copyPicks: picks });
    if (!script) {
      onError("That text has nothing in it to send.");
      return;
    }
    setTextDraft(null);
    player.stop();
    cancelLastLock();
    const sent = sendScript(script, sendingOf(script));
    const audio = encodeWavBuffer(sent.samples, sent.rate);
    setFile({ name: title, audio, rec: sent.rec, script });
    setKept(freshKept(keyOf(title, sent.rec, true), sent.rec, inputPref));
    setSelected(null);
    setPos(0);
    void keepCopyFile({ name: title, audio: new Blob([audio]), recording: sent.rec, script });
  };

  const openFile = useCallback(
    async (f: File) => {
      if (isTextFile(f)) {
        try {
          setTextDraft({ text: await f.text(), title: f.name, picks: [] });
        } catch {
          onError(`I could not read ${f.name}.`);
        }
        return;
      }
      player.stop();
      cancelLastLock();
      setReading(true);
      try {
        const loaded = await loadAudioFile(f);
        // The worker takes the samples; the bytes stay, to play.
        const r = await readRecording(loaded.clip.samples, loaded.clip.rate);
        if (!r || r.overs.length === 0) {
          onError(`I could not hear any CW in ${loaded.name}.`);
          return;
        }
        const key = keyOf(loaded.name, r);
        setFile({ name: loaded.name, audio: loaded.data, rec: r });
        setKept(freshKept(key, r, inputPref));
        setPos(0);
        void keepCopyFile({ name: loaded.name, audio: new Blob([loaded.data]), recording: r });
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setReading(false);
      }
    },
    [player, onError],
  );
  /** Generate QSO: a QSO generated in the kind chosen, in place of what was
   *  on the page. */
  const makeExchange = () => {
    player.stop();
    cancelLastLock();
    const script = makeScript({ kind, length: chatLength, qsos: runQsos });
    const sent = sendScript(script, sending);
    const audio = encodeWavBuffer(sent.samples, sent.rate);
    const name = nameOf(script);
    setFile({ name, audio, rec: sent.rec, script });
    setKept(freshKept(keyOf(name, sent.rec, true), sent.rec, inputPref));
    setSelected(null);
    setPos(0);
    void keepCopyFile({ name, audio: new Blob([audio]), recording: sent.rec, script });
  };

  /* A generated QSO sent again when its speed, gap, QSB or band changes, with your copy
     and where you are in it kept. A slider moves in steps, so this waits
     for it to settle. */
  const sendKey = `${gapSec}|${speedChoice}|${mine.charWpm}|${mine.farnsworthWpm}|${qsbDb}|${noiseDb}|${qrn}|${qrmDb}`;
  const sentWith = useRef(sendKey);
  useEffect(() => {
    if (!file?.script || sentWith.current === sendKey) return;
    const t = setTimeout(() => {
      sentWith.current = sendKey;
      const was = file.rec;
      const sent = sendScript(file.script!, sendingOf(file.script!));
      const audio = encodeWavBuffer(sent.samples, sent.rate);
      player.stop();
      cancelLastLock();
      setFile({ ...file, audio, rec: sent.rec });
      setPos((p) => timeIn(was, sent.rec, p));
      setKept((k) => (k ? { ...k, reached: timeIn(was, sent.rec, k.reached), at: timeIn(was, sent.rec, k.at) } : k));
      void keepCopyFile({ name: file.name, audio: new Blob([audio]), recording: sent.rec, script: file.script });
    }, 250);
    return () => clearTimeout(t);
    // Sent again on a change of how it is sent, not on each new file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendKey]);
  /* A new or recalled generated QSO is sent as the settings are now. */
  useEffect(() => {
    sentWith.current = sendKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.script]);

  useEffect(() => {
    fileTarget.current = (f) => void openFile(f);
    return () => {
      fileTarget.current = null;
    };
  }, [fileTarget, openFile]);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickFile = () => fileInput.current?.click();

  const duration = rec?.durationSec ?? 0;
  const ended = rec !== null && pos >= duration - 0.05;
  /** The speed the QSO is sent at, as the page shows it: one speed, or the
   *  slowest to the fastest of its stations. None for a recording. */
  const speedNow = ((): string | null => {
    const script = file?.script;
    if (!script) return null;
    const speeds = script.stations.map((st) => sendingOf(script).speed ?? st.speed);
    const shown = [...new Set(speeds.map(fmtSpeed))];
    if (shown.length === 1) return shown[0]!;
    const wpm = speeds.map((sp) => sp.charWpm);
    return `${Math.min(...wpm)}–${Math.max(...wpm)} wpm`;
  })();

  /* ---- downloads -------------------------------------------------------- */

  /** Save `blob` as `name`. */
  const save = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  /** The file name the downloads take, with no extension. */
  const stem = () =>
    (file?.name ?? "copy")
      .replace(/\.[a-z0-9]+$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "copy";
  /** Whether a QSO sent from text has anything added as it is heard. */
  const added = !!file?.script && anyAdded({ qsbDb, noiseDb, qrn, qrmDb });
  /** The QSO as it plays, with all that is added. A recording, as opened. */
  const downloadHeard = () => {
    if (!file) return;
    if (!file.script) save(new Blob([file.audio]), file.name);
    else save(new Blob([file.audio], { type: "audio/wav" }), `${stem()}${added ? "-as-heard" : ""}.wav`);
  };
  /** A QSO sent from text, with nothing added. */
  const downloadClean = () => {
    if (!file?.script) return;
    const quiet = { qsbDb: 0, noiseDb: NOISE_OFF_DB, qrn: 0, qrmDb: QRM_OFF_DB };
    const sent = sendScript(file.script, { ...sendingOf(file.script), ...quiet });
    save(encodeWav(sent.samples, sent.rate), `${stem()}.wav`);
  };
  /** Its lines as text, a blank line between them, as New exchange reads. */
  const downloadText = () => {
    if (!file) return;
    const text = file.script ? file.script.lines.map((l) => l.text) : file.rec.overs.map((o) => o.text);
    save(new Blob([`${text.join("\n\n")}\n`], { type: "text/plain" }), `${stem()}.txt`);
  };

  /** Wait between lines: a generated QSO stops after each line you copy,
   *  until you press Cmd+Enter (Ctrl+Enter off a Mac) in its box. */
  const waits = gap === "wait" && !!file?.script && linesShow === "copy";

  /* ---- playing ---------------------------------------------------------- */

  const play = (from = posRef.current, unlocked = lines) => {
    if (!file) return;
    const at = from >= duration - 0.05 ? 0 : Math.max(0, from);
    cancelLastLock();
    player.wake();
    mode.current = "main";
    setPlaying("main");
    setPos(at);
    // With Wait, it stops at the end of the next line still open. Starting
    // from the stop, that line is behind it, and it goes on to the next.
    const hold = waits && rec ? rec.overs.findIndex((o, i) => o.t1 + HOLD_PAD_SEC > at + 0.01 && !unlocked[i]?.locked) : -1;
    const to = hold >= 0 && hold < rec!.overs.length - 1 ? Math.min(rec!.overs[hold]!.t1 + HOLD_PAD_SEC, duration) : null;
    holdAt.current = to;
    void player.playBuffer(file.audio, at, to ?? undefined);
    requestAnimationFrame(backToSlot);
  };
  const pause = () => player.stop();
  const toggle = () => (mode.current === "main" ? pause() : play());

  /** Where the last skip back landed, while nothing else has moved the
   *  recording since. */
  const lastBack = useRef<number | null>(null);
  /** Move to `t`: playing on from there if it was playing. */
  const seek = (t: number | null) => {
    lastBack.current = null;
    if (t === null || !file) return;
    const at = Math.max(0, Math.min(duration, t));
    if (mode.current === "main") play(at);
    else {
      if (mode.current === "part") player.stop();
      setPos(at);
    }
  };
  /** Play one part of the recording, then stop. Where the recording is
   *  stays where it was. */
  const playPart = (from: number, to: number) => {
    if (!file) return;
    player.wake();
    mode.current = "part";
    setPlaying({ from, to });
    void player.playBuffer(file.audio, Math.max(0, from - PART_PAD_SEC), Math.min(duration, to + PART_PAD_SEC));
  };

  /** The slot selected last: its line and its place in the line. */
  const [selected, setSelected] = useState<{ line: number; slot: number } | null>(null);
  /** The slot selected last, to go back to when the recording plays. */
  const lastSlot = useRef<HTMLInputElement | null>(null);
  /** The selected slot's character and its word. */
  const selectedChar = () => {
    if (!rec || !selected) return null;
    const over = rec.overs[selected.line];
    if (!over) return null;
    let k = selected.slot;
    for (const w of over.words) {
      if (k < w.chars.length) return { char: w.chars[k]!, word: w };
      k -= w.chars.length;
    }
    return null;
  };
  const playLetter = () => {
    const at = selectedChar();
    if (at) playPart(at.char.t0, at.char.t1);
  };
  const playWord = () => {
    const at = selectedChar();
    if (at) playPart(at.word.chars[0]!.t0, at.word.chars.at(-1)!.t1);
  };
  /** A slot is selected. Paused, with the setting on, the recording moves
   *  to its character. */
  const selectSlot = (line: number, slot: number) => {
    setSelected({ line, slot });
    if (document.activeElement instanceof HTMLInputElement) lastSlot.current = document.activeElement;
    if (!seekSlot || mode.current !== null || !rec) return;
    const over = rec.overs[line];
    const c = over && charsOf(over)[slot];
    if (c) setPos(Math.max(0, c.t0 - PART_PAD_SEC));
  };

  const words = useMemo(() => (rec ? wordSpans(rec) : []), [rec]);
  const overs = useMemo(() => (rec ? overSpans(rec) : []), [rec]);
  /** Back to the start of the word or line, or the one before. Pressed
   *  again while that word or line plays, back one more. */
  const skipBack = (spans: readonly [number, number][]) => {
    const to = skipSpan(spans, posRef.current, -1, lastBack.current);
    seek(to === null ? null : leadIn(spans, to));
    lastBack.current = to;
  };
  /** Where the word you are copying starts: the selected slot's word, or
   *  in a box the word the cursor is in, counted by the words typed before
   *  it. Null when you are in no line. */
  const yourWord = (el: EventTarget | null): number | null => {
    if (input === "slots") return selectedChar()?.word.chars[0]!.t0 ?? null;
    const i = lineOf(el);
    const over = i === null ? undefined : rec?.overs[i];
    if (!over || !(el instanceof HTMLInputElement)) return null;
    const before = el.value.slice(0, el.selectionStart ?? el.value.length).trimStart();
    const k = before ? before.split(/\s+/).length - 1 : 0;
    return over.words[Math.min(k, over.words.length - 1)]?.chars[0]!.t0 ?? null;
  };
  /** Play on from the start of the word you are copying, a little before
   *  it. In no line, from the start of the word playing. */
  const fromWord = (el: EventTarget | null) => {
    const at = posRef.current;
    let start = yourWord(el);
    if (start === null) {
      let i = -1;
      for (let k = 0; k < words.length && words[k]![0] <= at + 0.01; k++) i = k;
      start = i < 0 ? null : words[i]![0];
    }
    play(start === null ? at : leadIn(words, start));
  };
  /** On to the next word or line, a little before it. */
  const skipOn = (spans: readonly [number, number][]) => {
    const to = skipSpan(spans, posRef.current, 1);
    seek(to === null ? null : leadIn(spans, to));
  };
  const back = (sec: number) => seek(posRef.current - sec);
  const on = (sec: number) => seek(posRef.current + sec);

  /* The furthest this attempt has played. Its lines up to there show. */
  const reached = Math.max(kept?.reached ?? 0, mode.current === "main" ? pos : 0);
  useEffect(() => {
    if (playing !== "main") return;
    setKept((k) => (k && pos > k.reached ? { ...k, reached: pos } : k));
  }, [pos, playing]);

  /* ---- your copy --------------------------------------------------------- */

  /** Change the lines of the attempt under way. */
  const setLines = (change: (lines: readonly LineCopy[]) => readonly LineCopy[]) =>
    setKept((k) => {
      if (!k) return k;
      const at = k.attempts.length - 1;
      const next = change(k.attempts[at]!.lines);
      if (next === k.attempts[at]!.lines) return k;
      return { ...k, attempts: k.attempts.map((a, i) => (i === at ? { ...a, lines: next } : a)) };
    });
  const setLine = (i: number, patch: Partial<LineCopy>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  /* With Lock on, a line locks when the next line starts, and the last line
     a few seconds after it ends. Only lines that are boxes to copy in. */
  useEffect(() => {
    if (!lock || !rec || linesShow !== "copy" || playing !== "main") return;
    setLines((ls) => {
      let changed = false;
      const next = ls.map((l, i) => {
        const after = rec.overs[i + 1];
        const due = after ? pos >= after.t0 : pos >= rec.overs[i]!.t1 + LAST_LOCK_SEC;
        if (l.locked || !due) return l;
        changed = true;
        return { ...l, locked: true };
      });
      return changed ? next : ls;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, lock, rec, linesShow, playing]);

  /* At the end of the recording, the last line has no next line to lock it,
     and the recording stops before it can run on: it locks a few seconds
     later. */
  atEnd.current = () => {
    setPos(duration);
    setKept((k) => (k ? { ...k, reached: duration } : k));
    if (!lock || linesShow !== "copy") return;
    cancelLastLock();
    lastLock.current = setTimeout(() => {
      lastLock.current = null;
      setLines((ls) => (ls.some((l) => !l.locked) ? ls.map((l) => (l.locked ? l : { ...l, locked: true })) : ls));
    }, LAST_LOCK_SEC * 1000);
  };

  /** Every copy you have made, as text, for whether you have a station's
   *  call. */
  const copies = useMemo(
    () =>
      rec && kept
        ? kept.attempts.flatMap((a) => a.lines.map((l, i) => copyText(rec.overs[i]!, l, a.input)))
        : [],
    [rec, kept],
  );

  /** The label of a line: the station's call once you have copied it, or
   *  Station until then. */
  const whoOf = (sender: number): string => {
    const s = rec?.senders[sender];
    const name = rec && rec.senders.length > 1 ? `Station ${sender + 1}` : "Station";
    if (!s?.call) return name;
    if (!hideCalls || kept?.revealed || heard(s.call, copies)) return s.call;
    return name;
  };

  const shown = rec && kept ? rec.overs.map((o, i) => ({ o, i })).filter(({ o }) => kept.revealed || o.t0 <= reached + 0.05) : [];

  /** An attempt's score: what it got right of the lines it locked. */
  const scoreOf = (a: Attempt) => {
    let right = 0;
    let total = 0;
    a.lines.forEach((l, i) => {
      if (!l.locked || !rec) return;
      const g = gradeLine(rec.overs[i]!, l, a.input);
      right += g.right;
      total += g.total;
    });
    return { right, total };
  };
  const locked = lines.some((l) => l.locked);
  /** Every line of this attempt locked and right: nothing to copy again. */
  const perfect =
    !!rec && lines.length > 0 && lines.every((l, i) => {
      if (!l.locked) return false;
      const g = gradeLine(rec.overs[i]!, l, input);
      return g.right === g.total;
    });
  /** Something to clear: a line typed or locked, the recording played, or
   *  an earlier attempt. */
  const started =
    !!kept &&
    (kept.attempts.length > 1 || kept.reached > 0 || pos > 0 || lines.some((l) => l.locked || l.typed || l.slots.some(Boolean)));

  /** Copy again: this attempt locks, and the next starts from the top, in
   *  Copy in as the settings have it. Each line starts from your last copy,
   *  or clean, as it does when the next attempt copies another way or the
   *  last was perfect. */
  const again = () => {
    if (!rec || !kept) return;
    const done: Attempt = { input, lines: lines.map((l) => (l.locked ? l : { ...l, locked: true })) };
    // After a perfect copy, nothing is left to keep: the next starts clean.
    const fromLast = earlier !== "none" && inputPref === input && !perfect;
    const fresh: Attempt = { input: inputPref, lines: lines.map((l, i) => nextCopy(rec.overs[i]!, l, fromLast)) };
    setKept({ ...kept, attempts: [...kept.attempts.slice(0, -1), done, fresh], reached: 0, revealed: false });
    setSelected(null);
    play(0);
  };
  /** Start over: every attempt goes, and nothing is played. */
  const restart = () => {
    if (!rec || !kept) return;
    player.stop();
    cancelLastLock();
    setKept(freshKept(kept.key, rec, inputPref));
    setSelected(null);
    setPos(0);
  };

  /** Clear: the recording and every attempt go, back to the guide. */
  const clear = () => {
    player.stop();
    cancelLastLock();
    setFile(null);
    setKept(null);
    setSelected(null);
    setPos(0);
    rememberCopy(null);
    void forgetCopyFile();
  };

  /* ---- keys ---------------------------------------------------------------- */

  const log = useRef<HTMLOListElement>(null);

  /** Back to the box you were copying in: the line playing now, or the
   *  last open one. In slots, its first empty slot. */
  const focusBox = (): boolean => {
    const root = log.current;
    if (!root) return false;
    const inputs = (li: Element | null) => [...(li?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    const now = inputs(root.querySelector("li.now"));
    const open = now.length ? now : inputs([...root.querySelectorAll("li")].reverse().find((li) => li.querySelector("input")) ?? null);
    const el = open.find((x) => !x.value) ?? open[0];
    el?.focus();
    return !!el;
  };

  /** Back to your slot as the recording plays: the one selected last, or
   *  the box you were copying in. Not when you are in a box already. */
  const backToSlot = () => {
    if (isBox(document.activeElement)) return;
    wantBox.current = false;
    if (lastSlot.current?.isConnected) lastSlot.current.focus();
    else if (!focusBox()) wantBox.current = true;
  };
  /** Back to your slot once there is one: a play from the start has no line
   *  to copy in until the first one starts. */
  const wantBox = useRef(false);
  useEffect(() => {
    if (!wantBox.current || isBox(document.activeElement)) return;
    // Not when you have gone on to something else since, such as a setting.
    const at = document.activeElement;
    if (at && at !== document.body && !(at instanceof HTMLButtonElement && at.closest("main.copy"))) {
      wantBox.current = false;
      return;
    }
    backToSlot();
  });

  /** After a click on a playback control: back to your slot, so you can
   *  type on. */
  const afterControl = (ev: React.MouseEvent) => {
    const el = (ev.target as HTMLElement).closest("button");
    if (!el || el.disabled || el.dataset.testid === "copy-line-edit") return;
    requestAnimationFrame(backToSlot);
  };

  /** The page's keys that move the recording: Space plays and pauses, and
   *  the arrows move by word, with Shift by five seconds. Whether it was
   *  one. */
  const moveKey = (ev: KeyboardEvent): boolean => {
    if (ev.key === " ") toggle();
    else if (ev.key === "ArrowLeft") {
      if (ev.shiftKey) back(5);
      else skipBack(words);
    } else if (ev.key === "ArrowRight") {
      if (ev.shiftKey) on(5);
      else skipOn(words);
    } else return false;
    ev.preventDefault();
    return true;
  };

  /** Lock line `i`. Stopped, it plays on: with `always`, from where it
   *  stopped, and otherwise only where Wait stopped after the line. Never
   *  from inside the line, which you have copied already. */
  const lockLine = (i: number, always: boolean) => {
    const open = !lines[i]?.locked;
    setLine(i, { locked: true });
    if (open && (always || waits) && mode.current === null && !ended) {
      const from = Math.max(posRef.current, rec?.overs[i]?.t1 ?? 0);
      play(from, lines.map((l, j) => (j === i ? { ...l, locked: true } : l)));
    }
  };

  /** Whether your copy of line `i` has every character, typed up to the
   *  box's last one, or in every slot. Right or not. */
  const copiedAll = (i: number, el: HTMLInputElement): boolean => {
    const l = lines[i];
    const over = rec?.overs[i];
    if (!l || !over || l.locked) return false;
    if (input === "slots") return l.slots.every(Boolean);
    const typed = plain(l.typed).replace(/ /g, "").length;
    return el.selectionStart === el.value.length && typed >= keyedOf(over).length;
  };

  /** The line of the box `el` is in, or null. */
  const lineOf = (el: EventTarget | null): number | null => {
    const line = isBox(el) ? el.closest<HTMLElement>("li[data-line]")?.dataset.line : undefined;
    return line === undefined ? null : Number(line);
  };

  /* Cmd on a Mac or Ctrl elsewhere with Enter, in a box, locks its line.
     With Wait, stopped after the line, it goes on too. */
  const modKey = (ev: KeyboardEvent): boolean => {
    if (!modOf(ev) || ev.key !== "Enter") return false;
    const i = lineOf(ev.target);
    if (i === null) return false;
    ev.preventDefault();
    lockLine(i, false);
    return true;
  };

  /* Playback with Option on a Mac or Alt elsewhere, in a box or out of one:
     R plays the line again, L the selected slot's letter and W its word,
     Enter plays on from the start of the word you are copying, and the
     page's keys work in a box. By the key's place, as Option
     changes the character a Mac types. */
  const altKey = (ev: KeyboardEvent): boolean => {
    if (!ev.altKey || ev.metaKey || ev.ctrlKey) return false;
    const plain = !ev.shiftKey;
    if (plain && ev.code === "KeyR") {
      if (!ev.repeat) replayLine(isBox(ev.target) ? ev.target : null);
    } else if (plain && ev.key === "Enter") fromWord(ev.target);
    else if (plain && ev.code === "KeyL" && input === "slots" && selected) playLetter();
    else if (plain && ev.code === "KeyW" && input === "slots" && selected) playWord();
    else if (plain && ev.code === "Space") toggle();
    else return moveKey(ev);
    ev.preventDefault();
    return true;
  };

  /* Outside a box: Space or Enter plays and pauses, Esc pauses, and the
     arrows move by word, with Shift by five seconds. In a box, Enter plays
     and pauses, and Esc leaves it; the rest is typing. */
  const keyRef = useRef<(ev: KeyboardEvent) => void>(() => {});
  keyRef.current = (ev) => {
    if (!rec || textDraft) return;
    const el = ev.target as HTMLElement | null;
    if (modKey(ev)) return;
    if (altKey(ev)) {
      if (!isBox(el)) requestAnimationFrame(backToSlot);
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (isBox(el)) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        // With every character of the line copied, Enter locks it and goes
        // on. Otherwise it plays and pauses.
        const i = lineOf(el);
        if (i !== null && copiedAll(i, el)) lockLine(i, true);
        else toggle();
      }
      return;
    }
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
    if (ev.key === "Escape") {
      if (mode.current) {
        ev.preventDefault();
        player.stop();
      }
      return;
    }
    // A character typed anywhere else goes into your slot.
    if (ev.key.length === 1 && ev.key !== " " && linesShow === "copy") {
      backToSlot();
      return;
    }
    if (el?.tagName === "BUTTON") return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      toggle();
      requestAnimationFrame(backToSlot);
    } else if (moveKey(ev)) requestAnimationFrame(backToSlot);
  };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => keyRef.current(ev);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ---- select to play ------------------------------------------------------ */

  /** A selection of what was sent plays that part. A click on a character
   *  plays its word. */
  const onLogMouseUp = (ev: React.MouseEvent) => {
    if (!rec || !log.current) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      let from = Infinity;
      let to = -Infinity;
      for (const el of log.current.querySelectorAll<HTMLElement>("[data-t0]")) {
        if (!range.intersectsNode(el)) continue;
        from = Math.min(from, Number(el.dataset.t0));
        to = Math.max(to, Number(el.dataset.t1));
      }
      if (from < to) playPart(from, to);
      return;
    }
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-t0]");
    if (!el || el.tagName === "INPUT") return;
    const word = wordAt(rec, Number(el.dataset.t0));
    if (word) playPart(word[0], word[1]);
  };

  /* ---- a line ------------------------------------------------------------ */

  /** An earlier attempt's copy of a line, drawn as your copy in the line
   *  under it is, open or locked, in slots or in the box, however it was
   *  copied. So the rows look alike, character over character. */
  const pastRow = (over: Over, copy: LineCopy, was: CopyInput, shut: boolean): React.ReactElement => {
    if (input === "slots") {
      const asSlots = was === "slots" ? copy : { ...copy, slots: slotsOfTyped(over, copy.typed) };
      if (shut) return <SlotsLocked over={over} copy={asSlots} marks sent={false} showCount={false} />;
      return <SlotsPast over={over} copy={asSlots} />;
    }
    if (was === "slots") return <SlotsAsText over={over} copy={copy} />;
    if (shut) {
      return <RightOnly sent={sentText(over)} typed={plain(copy.typed)} attrs={attrsOf(over)} testId="copy-past-right" />;
    }
    return <YourMarks sent={sentText(over)} typed={plain(copy.typed)} attrs={attrsOf(over)} />;
  };

  /** Your earlier attempts at line `i`, oldest first, as the setting picks
   *  them, each graded as it was copied. Not while the line shows what was
   *  sent instead. */
  const pastOf = (over: Over, i: number): React.ReactElement | null => {
    if (!kept || earlier === "none" || linesShow !== "copy" || attempt === 0) return null;
    const from = earlier === "all" ? 0 : attempt - 1;
    const past = kept.attempts.slice(from, attempt);
    return (
      <span className="pastcopies">
        {past.map((a, k) => {
          const copy = a.lines[i]!;
          const g = gradeLine(over, copy, a.input);
          return (
            <span key={k} className="copyrow pastcopy" data-testid="copy-past">
              {pastRow(over, copy, a.input, lines[i]!.locked || kept.revealed)}
              <span className="rowscore">
                #{from + k + 1} · {g.right}/{g.total}
              </span>
            </span>
          );
        })}
      </span>
    );
  };

  /** This attempt's copy of line `i`: a box to type in, or what it shows
   *  once locked. */
  const copyOf = (over: Over, i: number, label: string): React.ReactElement => {
    const copy = lines[i]!;
    // With the answers showing, a line shows as it does locked, and the
    // answer goes under it, so nothing already on the page moves.
    if (copy.locked || kept!.revealed) {
      if (input === "slots") {
        return (
          <SlotsLocked
            over={over}
            copy={copy}
            marks={lockedShows !== "nothing" || kept!.revealed}
            sent={lockedShows === "grade" || kept!.revealed}
            showCount={false}
          />
        );
      }
      if (lockedShows === "grade") {
        return <Graded sent={sentText(over)} typed={plain(copy.typed)} attrs={attrsOf(over)} showCount={false} />;
      }
      if (lockedShows === "right") {
        return <RightOnly sent={sentText(over)} typed={plain(copy.typed)} attrs={attrsOf(over)} testId="copy-right-only" />;
      }
      return <YourCopy sent={sentText(over)} typed={plain(copy.typed)} attrs={attrsOf(over)} testId="copy-locked" />;
    }
    if (input === "slots") {
      return (
        <Slots
          over={over}
          copy={copy}
          label={label}
          at={follow && nowAt !== null ? nowAt : undefined}
          grade={gradeTyping}
          onSlots={(slots) => setLine(i, { slots })}
          onSelect={(slot) => selectSlot(i, slot)}
        />
      );
    }
    return (
      <input
        className="qsotype"
        data-testid="copy-type"
        aria-label={`Your copy of ${label}`}
        value={copy.typed}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        ref={(el) => {
          // A box that starts with your last copy starts with the cursor at
          // its start, where you copy from. Once, as the box appears.
          if (!el || el.dataset.placed) return;
          el.dataset.placed = "1";
          if (el.value) requestAnimationFrame(() => el.setSelectionRange(0, 0));
        }}
        onKeyDown={(ev) => {
          // With Cmd, Ctrl, Option or Alt, a key is the page's.
          if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.currentTarget.blur();
          }
        }}
        onChange={(ev) => setLine(i, { typed: ev.target.value })}
      />
    );
  };

  /** What line `i` shows. */
  const textOf = (over: Over, i: number, label: string): React.ReactElement => {
    if (!kept!.revealed && linesShow === "before") return <SentText over={over} />;
    if (!kept!.revealed && linesShow === "sent") return <SentText over={over} upTo={reached} />;
    const copy = lines[i]!;
    const g = copy.locked || kept!.revealed ? gradeLine(over, copy, input) : null;
    const boxed = !copy.locked && !kept!.revealed && input === "text";
    return (
      <span className={boxed ? "text copycell boxed" : "text copycell"}>
        {pastOf(over, i)}
        <span className="copyrow">
          {copyOf(over, i, label)}
          {g ? (
            <span className="rowscore" data-testid="copy-line-score">
              {kept!.attempts.length > 1 && `#${attempt + 1} · `}
              {g.right}/{g.total}
            </span>
          ) : (
            <span className="rowscore" />
          )}
        </span>
        {kept!.revealed && input === "text" && lockedShows !== "grade" && (
          <span className="copyrow">
            <SentMarks sent={sentText(over)} typed={plain(copy.typed)} attrs={attrsOf(over)} />
            <span className="rowscore" />
          </span>
        )}
      </span>
    );
  };

  /** The play button at the end of a line. */
  const linePlay = (over: Over, i: number): React.ReactElement => {
    const on =
      typeof playing === "object" && playing !== null && playing.from === over.t0 && playing.to === over.t1;
    return (
      <button
        type="button"
        className="iconbtn qsoplay"
        data-testid="copy-line-play"
        aria-label={on ? "Stop" : `Play line ${i + 1}`}
        title={on ? "Stop" : "Play this line"}
        onClick={() => (on ? player.stop() : playPart(over.t0, over.t1))}
      >
        {on ? <IconStop /> : <IconPlay />}
      </button>
    );
  };

  /** The speed line `i` of a generated QSO was sent at, as the QSO page
   *  shows a line's speed. None for a recording. */
  const lineSpeed = (i: number): React.ReactElement | null => {
    const line = file?.script?.lines[i];
    if (!showSpeed || !line) return null;
    const speed = sendingOf(file!.script!).speed ?? file!.script!.stations[line.station]!.speed;
    return (
      <span className="lwpm" data-testid="copy-line-wpm">
        {fmtSpeed(speed)}
      </span>
    );
  };

  /** Edit, on a locked copy of the attempt under way. */
  const lineEdit = (i: number): React.ReactElement | null => {
    if (!allowEdits || linesShow !== "copy") return null;
    // Its place kept on a line that cannot be edited, so every line's speed
    // and play button line up.
    if (!lines[i]?.locked) return <span className="lspace" aria-hidden="true" />;
    return (
      <button
        type="button"
        className="iconbtn qsoplay"
        data-testid="copy-line-edit"
        aria-label="Edit my copy"
        title="Edit my copy"
        onClick={() => setLine(i, { locked: false })}
      >
        <IconEdit />
      </button>
    );
  };

  /** Option+R or Alt+R: the line plays again. The line of the box you are in,
   *  or else the line playing, or the last one heard. As the QSO page's
   *  Option+R plays the station's last line. Again while it plays stops it. */
  const replayLine = (box: HTMLElement | null) => {
    if (!rec) return;
    const inBox = box?.closest<HTMLElement>("li[data-line]")?.dataset.line;
    const heardLast = rec.overs.reduce((last, o, i) => (o.t0 <= reached + 0.05 ? i : last), -1);
    const i = inBox !== undefined ? Number(inBox) : nowLine >= 0 ? nowLine : heardLast;
    const over = rec.overs[i];
    if (!over) return;
    if (typeof playing === "object" && playing?.from === over.t0) player.stop();
    else playPart(over.t0, over.t1);
  };

  /** The line playing now: the one the recording is in, or the part. */
  const nowAt = mode.current === "part" ? partAt : mode.current === "main" ? pos : null;
  const nowLine =
    rec && nowAt !== null ? rec.overs.findIndex((o, i) => nowAt >= o.t0 - 0.05 && nowAt < (rec.overs[i + 1]?.t0 ?? Infinity)) : -1;

  /** With Wait, the line it stopped after, waiting for Enter, or -1. */
  const heldLine =
    waits && rec && playing === null
      ? rec.overs.findIndex((o, i) => !lines[i]?.locked && pos >= o.t1 - 0.05 && pos <= o.t1 + HOLD_PAD_SEC + 0.1)
      : -1;

  const status = reading
    ? "Reading the recording…"
    : !rec
      ? recalling
        ? ""
        : "Generate a QSO to copy, write your own, or open a recording of CW."
      : playing === "main"
        ? linesShow === "copy"
          ? "Type what you hear in each line."
          : "Listen along."
        : heldLine >= 0
          ? `Type what you heard, then press ${MOD}+Enter to lock it and go on.`
          : linesShow === "copy" && perfect
            ? "You copied every line. Copy again starts a fresh attempt."
            : ended
              ? linesShow === "copy"
                ? "Copy again to go once more."
                : file?.script
                  ? "The QSO is over."
                  : "The recording is over."
              : pos > 0
                ? "Press Play to go on."
                : linesShow === "copy"
                  ? "Press Start, then type what you hear."
                  : "Press Start to listen.";

  /** Where things are, in a word, over the sentence that says what to do. */
  const state: CopyState | null = reading
    ? "reading"
    : !rec
      ? recalling
        ? null
        : "none"
      : playing === "main"
        ? "playing"
        : ended
          ? "over"
          : pos > 0
            ? "paused"
            : "ready";
  /** This attempt has not played yet. */
  const fresh = !!kept && kept.reached === 0 && pos === 0;

  const skip = (label: string, title: string, run: () => void, testId: string) => (
    <button type="button" aria-label={title} title={title} data-testid={testId} disabled={!rec} onClick={run}>
      {label}
    </button>
  );

  /** A button that plays the selected slot's letter or word. A press keeps
   *  you in the slot. */
  const slotPlay = (label: string, title: string, run: () => void, testId: string) => (
    <button
      type="button"
      aria-label={title}
      title={title}
      data-testid={testId}
      disabled={!rec || !selected}
      onMouseDown={(ev) => ev.preventDefault()}
      onClick={run}
    >
      <i className="ico">
        <IconPlay />
      </i>
      {label}
    </button>
  );

  const current = kept ? scoreOf(kept.attempts[attempt]!) : { right: 0, total: 0 };

  return (
    <>
      <header>
        <HomeButton onHome={onHome} />
        <PageSwitch page="copy" onPage={onPage} />
        <button
          className={rec ? undefined : "primary"}
          data-testid="copy-new"
          disabled={reading || playing !== null}
          title={`Generate a new QSO to copy: ${KINDS.find((k) => k.value === kind)!.label}, as the settings have it`}
          onClick={makeExchange}
        >
          Generate QSO
        </button>
        <button
          data-testid="copy-text-open"
          disabled={reading || playing !== null}
          title="Paste or type an exchange of your own to copy, sent in CW"
          onClick={editText}
        >
          New exchange
        </button>
        {/* Icon only, after Generate QSO and New exchange: a recording is the rarer way in,
            as on the Send page. */}
        <button
          className="iconbtn copyopen"
          data-testid="copy-open"
          disabled={reading}
          aria-label="Open a recording or a text file"
          title="Open a recording of CW or a .txt file to copy, or drop one on the page"
          onClick={pickFile}
        >
          <IconUpload />
        </button>
        {/* Always here, as on the other pages. Off while the recording plays
            or before there is one. */}
        <button
          data-testid="copy-clear"
          disabled={!rec || reading || playing !== null}
          title="Close this QSO and clear every attempt"
          onClick={clear}
        >
          Clear
        </button>
        <div className="cornergroup">
          <button className="iconbtn cornerbtn" aria-label="Configuration" title="Configuration" onClick={onConfigure}>
            <IconUser />
          </button>
          <ChartSettingsButton open={settingsOpen} onToggle={() => setSettingsOpen(!settingsOpen)} />
        </div>
      </header>

      <SettingsBand open={settingsOpen}>
        <SettingsPanel
          className="formpanel qsopanel"
          gainDb={gainDb}
          onGainDb={setGainDb}
          audioExtra={
            <>
              <QsbSlider qsbDb={qsbDb} onChange={setQsbDb} />
              <NoiseSlider noiseDb={noiseDb} onChange={setNoiseDb} />
              <QrnSlider qrn={qrn} onChange={setQrn} />
              <QrmSlider qrmDb={qrmDb} onChange={setQrmDb} />
            </>
          }
          pageRow={
            <>
              <Section name="copy" title="Your copy">
                <div className="panelgroups">
                  <ChoiceGroup
                    id="copy-input"
                    label="Copy in"
                    help={INPUT_HELP}
                    value={inputPref}
                    options={INPUTS}
                    onChange={(v) => setInput(v as CopyInput)}
                  />
                  <SettingRow label="Slots">
                    <Check
                      id="copy-follow"
                      label="Highlight the active slot"
                      help={FOLLOW_HELP}
                      checked={follow}
                      onChange={setFollow}
                    />
                    <Check
                      id="copy-grade-typing"
                      label="Grade slots as I type"
                      help={GRADE_TYPING_HELP}
                      checked={gradeTyping}
                      onChange={setGradeTyping}
                    />
                    <Check
                      id="copy-seek-slot"
                      label="When paused, move to the slot I select"
                      help={SEEK_SLOT_HELP}
                      checked={seekSlot}
                      onChange={setSeekSlot}
                    />
                  </SettingRow>
                  <SettingRow label="When the next line starts">
                    <Check id="copy-lock" label="Lock my copy" help={LOCK_HELP} checked={lock} onChange={setLock} />
                  </SettingRow>
                  <ChoiceGroup
                    id="copy-locked-shows"
                    label="My locked copy shows"
                    help={LOCKED_SHOWS_HELP}
                    value={lockedShows}
                    options={LOCKED_SHOWS}
                    onChange={(v) => setLockedShows(v as LockedShows)}
                  />
                  <Check
                    id="copy-allow-edits"
                    label="Allow edits"
                    help={ALLOW_EDITS_HELP}
                    checked={allowEdits}
                    onChange={setAllowEdits}
                  />
                  <ChoiceGroup
                    id="copy-earlier"
                    label="When I copy again, show"
                    help={EARLIER_HELP}
                    value={earlier}
                    options={EARLIERS}
                    onChange={(v) => setEarlier(v as Earlier)}
                  />
                </div>
              </Section>
              <Section name="make" title="Generated QSOs and your text">
                <div className="panelgroups">
                  <ChoiceGroup
                    id="copy-kind"
                    label="Kind"
                    help={KIND_HELP}
                    value={kind}
                    options={KINDS}
                    onChange={(v) => setKind(v as Kind)}
                  />
                  <ChoiceGroup
                    id="copy-run-qsos"
                    label="QSOs in a run"
                    help={RUN_QSOS_HELP}
                    value={String(runQsos)}
                    options={RUN_QSOS}
                    onChange={(v) => setRunQsos(Number(v))}
                  />
                  <ChoiceGroup
                    id="copy-chat-length"
                    label="A standard QSO is"
                    help={CHAT_LENGTH_HELP}
                    value={chatLength}
                    options={CHAT_LENGTHS}
                    onChange={(v) => setChatLength(v as Length)}
                  />
                  <ChoiceGroup
                    id="copy-gap"
                    label="Between lines"
                    help={GAP_HELP}
                    value={gap}
                    options={GAPS}
                    onChange={(v) => setGap(v as Gap)}
                  />
                  <ChoiceGroup
                    id="copy-speed"
                    label="Speed"
                    help={SPEED_HELP}
                    value={speedChoice}
                    options={SPEEDS}
                    onChange={(v) => setSpeedChoice(v as SpeedChoice)}
                  />
                  <SpeedSliders charWpm={mine.charWpm} farnsworthWpm={mine.farnsworthWpm} onChange={setMine} />
                </div>
              </Section>
            </>
          }
        >
          {/* Beside Audio, as Speed is on the QSO page. */}
          <Section name="lines" title="The recording">
            <div className="panelgroups">
              <ChoiceGroup
                id="copy-lines"
                label="Its lines show"
                help={LINES_SHOW_HELP}
                value={linesShow}
                options={LINES_SHOW}
                onChange={(v) => setLinesShow(v as LinesShow)}
              />
              <Check
                id="copy-hide-calls"
                label="Hide each call until I copy it"
                help={HIDE_CALLS_HELP}
                checked={hideCalls}
                onChange={setHideCalls}
              />
              <Check
                id="copy-show-speed"
                label="Show its speed on each line"
                help={SHOW_SPEED_HELP}
                checked={showSpeed}
                onChange={setShowSpeed}
              />
              <Check
                id="copy-show-download"
                label="Show Download, to save it as audio or text"
                help={SHOW_DOWNLOAD_HELP}
                checked={showDownload}
                onChange={setShowDownload}
              />
            </div>
          </Section>
        </SettingsPanel>
      </SettingsBand>

      <main className="panel qso copy" data-testid="copy">
        <div className="copytop">
          <div className="copyhead" role="status" aria-live="polite">
            {state && (
              <span className="uplabel" data-testid="copy-state" data-state={state}>
                {STATE_WORDS[state]}
                {kept && kept.attempts.length > 1 && <span data-testid="copy-attempt"> · Attempt {kept.attempts.length}</span>}
              </span>
            )}
            <span className="copysay">{status}</span>
          </div>
          {/* What acts on your attempts, by the line that names the attempt:
              Start over, Show answers, then Copy again, the next step.
              Always here once there is a recording, so nothing moves. Off
              until there is a copy to check. */}
          {rec && (
            <div className="copyattempt">
              <button
                data-testid="copy-restart"
                disabled={!started}
                title="Clear every attempt and go back to the start"
                onClick={restart}
              >
                Start over
              </button>
              <div className="modeswitch" role="group" aria-label="Show answers">
                <button
                  aria-pressed={!!kept?.revealed}
                  data-testid="copy-reveal"
                  disabled={!started || !kept}
                  title={kept?.revealed ? "Hide what was sent" : "Show what was sent, under your copy of each line"}
                  onClick={() => kept && setKept({ ...kept, revealed: !kept.revealed })}
                >
                  Show answers
                </button>
              </div>
              {linesShow === "copy" && (
                <button
                  className={(ended && locked) || perfect ? "primary" : undefined}
                  data-testid="copy-again"
                  disabled={!locked && !ended}
                  title="Play the whole recording again and copy it once more"
                  onClick={again}
                >
                  Copy again
                </button>
              )}
            </div>
          )}
        </div>

        {rec && (
          <>
            <div className="qsocontrols" onClick={afterControl}>
              <button className="primary copyplay" data-testid="copy-play" onClick={toggle}>
                <i className="ico">{playing === "main" ? <IconPause /> : <IconPlay />}</i>
                {playing === "main" ? "Pause" : fresh ? "Start" : "Play"}
              </button>
              <span className="copyclock" data-testid="copy-clock">
                {clock(pos)} / {clock(duration)}
              </span>
              <input
                type="range"
                className="copyscrub"
                aria-label="Where the recording is"
                min={0}
                max={duration}
                step={0.1}
                value={Math.min(pos, duration)}
                onChange={(e) => seek(Number(e.target.value))}
              />
              {speedNow && (
                <span className="hint copyspeed" data-testid="copy-sent-speed" title="The speed it is sent at, from the settings">
                  {speedNow}
                </span>
              )}
              <span className="hint copyname" title={file!.name}>
                {file!.name}
              </span>
            </div>
            <div className="qsocontrols copyskips" onClick={afterControl}>
              <div className="modeswitch" role="group" aria-label="Back">
                {skip("‹ Line", "Back a line", () => skipBack(overs), "copy-back-line")}
                {skip("‹ 15s", "Back 15 seconds", () => back(15), "copy-back-15")}
                {skip("‹ 5s", "Back 5 seconds", () => back(5), "copy-back-5")}
                {skip("‹ Word", "Back a word", () => skipBack(words), "copy-back-word")}
              </div>
              <div className="modeswitch" role="group" aria-label="On">
                {skip("Word ›", "On a word", () => skipOn(words), "copy-on-word")}
                {skip("5s ›", "On 5 seconds", () => on(5), "copy-on-5")}
                {skip("15s ›", "On 15 seconds", () => on(15), "copy-on-15")}
                {skip("Line ›", "On a line", () => skipOn(overs), "copy-on-line")}
              </div>
              {input === "slots" && (
                <div className="modeswitch" role="group" aria-label="Play the selected slot">
                  {slotPlay("Letter", `Play the selected letter (${ALT}+L)`, playLetter, "copy-play-letter")}
                  {slotPlay("Word", `Play the selected word (${ALT}+W)`, playWord, "copy-play-word")}
                </div>
              )}
            </div>
          </>
        )}

        {!rec && !recalling && !reading && (
          <div className="qsocontrols copyfirst">
            <div className="modeswitch" role="group" aria-label="Kind" data-testid="copy-kind-first">
              {KINDS.map((k) => (
                <button key={k.value} aria-pressed={kind === k.value} title={k.note} onClick={() => setKind(k.value)}>
                  {k.label}
                </button>
              ))}
            </div>
            <button className="primary" data-testid="copy-new-first" onClick={makeExchange}>
              Generate QSO
            </button>
            <span className="hint">
              or{" "}
              <button type="button" className="link" data-testid="copy-text-first" onClick={editText}>
                write your own
              </button>
              ,{" "}
              <button type="button" className="link" data-testid="copy-open-first" onClick={pickFile}>
                open a recording or a .txt file
              </button>
              , or drop one on the page
            </span>
          </div>
        )}

        {!rec && !recalling && !reading && (
          <div className="qsoguide prose" data-testid="copy-guide">
            <p>Copy a QSO in CW as it plays, and see what you got right.</p>
            <ul>
              <li>A new line appears each time a new station starts sending.</li>
              <li>Type what you hear in each line.</li>
              <li>Your copy of a line locks when the next line starts, or 5 seconds after the recording ends.</li>
              <li>
                <b>Copy again</b> plays the whole recording from the start. Your earlier attempts stay on the page, so
                you can see yourself improve.
              </li>
              <li>Click a word in a finished line, or select part of it, to hear it again.</li>
            </ul>
            {settingsOpen ? (
              <p>
                Change the speed of a generated QSO or your own text, and the pause between its lines, in the settings
                panel.
              </p>
            ) : (
              <p>
                Open the{" "}
                <button type="button" className="link" data-testid="copy-guide-settings" onClick={() => setSettingsOpen(true)}>
                  settings
                </button>{" "}
                to change the speed of a generated QSO or your own text, and the pause between its lines.
              </p>
            )}
          </div>
        )}

        {rec && kept && (
          <ol className="qsolog copylog" data-testid="copy-log" ref={log} onMouseUp={onLogMouseUp} onClick={afterControl}>
            {shown.map(({ o, i }) => {
              const label = whoOf(o.sender);
              return (
                <li
                  key={`${attempt}-${i}`}
                  className={i === nowLine ? "them now" : "them"}
                  data-sender={o.sender}
                  data-line={i}
                  data-testid="copy-line"
                >
                  <span className="who">{label}</span>
                  {textOf(o, i, label)}
                  <span className="lend">
                    {lineSpeed(i)}
                  {lineEdit(i)}
                  {linePlay(o, i)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {rec && kept && (
          <div className="copyafter">
            {current.total > 0 && (
              <p className="hint qsonote" data-testid="copy-score">
                {current.right} of {current.total} copied in the lines locked so far.
              </p>
            )}
            {showDownload && (
              <div className="copydownloads" data-testid="copy-downloads">
                <button
                  type="button"
                  data-testid={added ? "copy-download-clean" : "copy-download"}
                  title={added ? "Save the QSO as a WAV file, with nothing added" : "Save the QSO as audio"}
                  onClick={added ? downloadClean : downloadHeard}
                >
                  <i className="ico">
                    <IconDownload />
                  </i>
                  {added ? "Download clean" : "Download"}
                </button>
                {added && (
                  <button
                    type="button"
                    data-testid="copy-download-heard"
                    title="Save the QSO as a WAV file, with the QSB, noise, QRN and QRM you hear"
                    onClick={downloadHeard}
                  >
                    <i className="ico">
                      <IconDownload />
                    </i>
                    Download as heard
                  </button>
                )}
                <button
                  type="button"
                  data-testid="copy-download-text"
                  title="Save the QSO's lines as a text file, which New exchange can open"
                  onClick={downloadText}
                >
                  <i className="ico">
                    <IconDownload />
                  </i>
                  Download text
                </button>
              </div>
            )}
          </div>
        )}
        <input
          ref={fileInput}
          className="visually-hidden"
          tabIndex={-1}
          type="file"
          accept={`${ACCEPTED},.txt,text/plain`}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openFile(f);
            e.target.value = "";
          }}
        />

        {rec && (
          <div className="copykeys">
            <p className="legend keys" data-testid="copy-hotkeys">
              On the page: <kbd>Space</kbd> or <kbd>Enter</kbd> play or pause &nbsp;·&nbsp; <kbd>Esc</kbd> pause
              &nbsp;·&nbsp; <kbd>{ALT}</kbd> <kbd>R</kbd> play the line again &nbsp;·&nbsp; <kbd>{ALT}</kbd>{" "}
              <kbd>Enter</kbd> play from your word
              &nbsp;·&nbsp; <kbd>←</kbd> <kbd>→</kbd> a word &nbsp;·&nbsp; <kbd>Shift</kbd> <kbd>←</kbd> <kbd>→</kbd> 5s
              {input === "slots" && (
                <>
                  {" "}
                  &nbsp;·&nbsp; <kbd>{ALT}</kbd> <kbd>L</kbd> <kbd>{ALT}</kbd> <kbd>W</kbd> the selected letter or word
                </>
              )}
            </p>
            {/* Only the keys the settings use: none in a box with no boxes. */}
            {linesShow === "copy" && (
              <p className="legend keys" data-testid="copy-box-keys">
                In a box: <kbd>Enter</kbd> play or pause, or lock a line copied in full and go on &nbsp;·&nbsp; <kbd>{MOD}</kbd> <kbd>Enter</kbd>{" "}
                {waits ? "lock the line and go on" : "lock the line"}
                {input === "slots" && (
                  <>
                    {" "}
                    &nbsp;·&nbsp; <kbd>{ALT}</kbd> <kbd>L</kbd> <kbd>{ALT}</kbd> <kbd>W</kbd> the selected letter or word
                  </>
                )}
                &nbsp;·&nbsp; <kbd>Esc</kbd> leave the box &nbsp;·&nbsp; hold <kbd>{ALT}</kbd> for the other keys
              </p>
            )}
          </div>
        )}
      </main>
      {textDraft && (
        <CopyText
          text={textDraft.text}
          picks={textDraft.picks}
          onStart={(next) => startText(next.text, textDraft.title, next.picks)}
          onCancel={() => setTextDraft(null)}
          onConfigureUser={() => {
            setTextDraft(null);
            onConfigure();
          }}
        />
      )}
    </>
  );
}
