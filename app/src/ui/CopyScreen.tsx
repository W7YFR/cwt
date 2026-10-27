/* The Copy page: play a recording of CW and copy it.
 *
 * You open a recording, and the decoder reads it whole before you start. What
 * it reads is the answer key. The recording plays, and each over shows as a
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
import { ACCEPTED, loadAudioFile } from "@/capture/file";
import type { Over, Recording } from "@/copy/decode";
import {
  charsOf,
  clock,
  copyText,
  emptyCopy,
  gradeLine,
  heard,
  keyedOf,
  nextCopy,
  overSpans,
  plain,
  sentText,
  skipSpan,
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
  recallCopy,
  recallCopyFile,
  rememberCopy,
  savePrefs,
  type Prefs,
} from "@/io/storage";
import type { LockedShows } from "@/qso/show";
import { ChartSettingsButton, Check, ChoiceGroup, Section, SettingRow, SettingsBand, SettingsPanel } from "./Controls";
import { Graded, RightOnly, SentMarks, YourCopy, YourMarks, type SentAttrs } from "./Graded";
import { IconPause, IconPlay, IconStop, IconUpload, IconUser } from "./Icons";
import { PageSwitch, type Page } from "./PageSwitch";
import { isRecording, readRecording } from "./readRecording";
import { SentText, Slots, SlotsLocked, SlotsPast } from "./Slots";
import { HomeButton } from "./Wordmark";

/** How long after the last line ends its copy locks, when Lock is on. Every
 *  other line locks when the next one starts. */
const LAST_LOCK_SEC = 5;

/** A play of part of the recording starts this much before it and ends this
 *  much after, so its first and last characters are heard whole. */
const PART_PAD_SEC = 0.15;

/** The key that takes the page's keys into a box: Cmd on a Mac, Ctrl
 *  elsewhere. */
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = MAC ? "⌘" : "Ctrl";
const modOf = (ev: KeyboardEvent) => (MAC ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey) && !ev.altKey;

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
  "many characters each word has, so they are the easier way to copy.";

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

const FOLLOW_HELP =
  "The slot for the character playing now is highlighted, so you can see where the audio " +
  "is in the line.";

const GRADE_TYPING_HELP =
  "A dot under each slot you fill says if it is right: blue if right, red if not.";
const SEEK_SLOT_HELP =
  "While the recording is paused, it moves to the character of the slot you select. Play " +
  "goes on from there.";

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

/** Where the page is, as its heading says in a word. */
type CopyState = "reading" | "none" | "playing" | "over" | "paused" | "ready";
const STATE_WORDS: Record<CopyState, string> = {
  reading: "Reading",
  none: "No recording",
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

/** Which recording `rec` is, so a copy kept for another is not put on it. */
function keyOf(name: string, rec: Recording): string {
  return `${name}|${rec.durationSec.toFixed(2)}|${rec.overs.length}`;
}

/** A fresh copy of `rec`: one attempt, nothing typed and nothing played. */
function freshKept(key: string, rec: Recording): Kept {
  return { v: 2, key, attempts: [{ lines: rec.overs.map(emptyCopy) }], reached: 0, at: 0, revealed: false };
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

/** Your copy as last kept, if it is of `rec`. A copy kept before attempts
 *  is its first attempt. */
function recallKept(key: string, rec: Recording): Kept | null {
  const k = recallCopy() as
    | (Partial<Omit<Kept, "v">> & { v?: number; lines?: Partial<LineCopy>[] })
    | null;
  if (!k || k.key !== key || typeof k.reached !== "number" || typeof k.at !== "number") return null;
  const raw = k.v === 1 ? [{ lines: k.lines }] : k.v === 2 ? k.attempts : null;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every((a) => Array.isArray(a?.lines) && a.lines.length === rec.overs.length)) return null;
  const attempts = raw.map((a) => ({ lines: a!.lines!.map((l, i) => lineBack(l, rec.overs[i]!)) }));
  return { v: 2, key, attempts, reached: k.reached, at: k.at, revealed: k.revealed === true };
}

type OnOffKey = "copySettingsOpen" | "copyLock" | "copyHideCalls" | "copyFollow" | "copyGradeTyping" | "copySeekSlot";

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
function useChoice<K extends "copyInput" | "copyLines" | "copyLockedShows" | "copyEarlier">(
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
  const [input, setInput] = useChoice("copyInput", "text");
  const [linesShow, setLinesShow] = useChoice("copyLines", "copy");
  const [lockedShows, setLockedShows] = useChoice("copyLockedShows", "right");
  const [earlier, setEarlier] = useChoice("copyEarlier", "last");

  /** The recording: its name, its own bytes to play, and what was read. */
  const [file, setFile] = useState<{ name: string; audio: ArrayBuffer; rec: Recording } | null>(null);
  /** The recording kept from before is coming back. */
  const [recalling, setRecalling] = useState(true);
  const [reading, setReading] = useState(false);
  const [kept, setKept] = useState<Kept | null>(null);
  const rec = file?.rec ?? null;
  const attempt = kept ? kept.attempts.length - 1 : 0;
  const lines = kept?.attempts[attempt]?.lines ?? [];

  /** Where the recording is: where it plays from, and where it is playing. */
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  posRef.current = pos;
  /** What is playing: the recording from where it is, or one part of it. */
  const [playing, setPlaying] = useState<"main" | { from: number; to: number } | null>(null);
  const mode = useRef<"main" | "part" | null>(null);
  const [partAt, setPartAt] = useState<number | null>(null);
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
          if (was === "main" && reason === "done") atEnd.current();
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
        const key = keyOf(stored.name, r);
        const back = recallKept(key, r) ?? freshKept(key, r);
        setFile({ name: stored.name, audio, rec: r });
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

  const openFile = useCallback(
    async (f: File) => {
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
        setKept(freshKept(key, r));
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

  /* ---- playing ---------------------------------------------------------- */

  const play = (from = posRef.current) => {
    if (!file) return;
    const at = from >= duration - 0.05 ? 0 : Math.max(0, from);
    cancelLastLock();
    player.wake();
    mode.current = "main";
    setPlaying("main");
    setPos(at);
    void player.playBuffer(file.audio, at);
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
    seek(to);
    lastBack.current = to;
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
      return { ...k, attempts: k.attempts.map((a, i) => (i === at ? { lines: next } : a)) };
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
        ? kept.attempts.flatMap((a) => a.lines.map((l, i) => copyText(rec.overs[i]!, l, input)))
        : [],
    [rec, kept, input],
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
      const g = gradeLine(rec.overs[i]!, l, input);
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

  /** Copy again: this attempt locks, and the next starts from the top. Each
   *  line starts from your last copy, or clean. */
  const again = () => {
    if (!rec || !kept) return;
    const done: Attempt = { lines: lines.map((l) => (l.locked ? l : { ...l, locked: true })) };
    const fresh: Attempt = { lines: lines.map((l, i) => nextCopy(rec.overs[i]!, l, earlier !== "none")) };
    setKept({ ...kept, attempts: [...kept.attempts.slice(0, -1), done, fresh], reached: 0, revealed: false });
    setSelected(null);
    play(0);
  };
  /** Start over: every attempt goes, and nothing is played. */
  const restart = () => {
    if (!rec || !kept) return;
    player.stop();
    cancelLastLock();
    setKept(freshKept(kept.key, rec));
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
  const focusBox = () => {
    const root = log.current;
    if (!root) return;
    const inputs = (li: Element | null) => [...(li?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    const now = inputs(root.querySelector("li.now"));
    const open = now.length ? now : inputs([...root.querySelectorAll("li")].reverse().find((li) => li.querySelector("input")) ?? null);
    const el = open.find((x) => !x.value) ?? open[0];
    el?.focus();
  };

  /** Back to your slot as the recording plays: the one selected last, or
   *  the box you were copying in. Not when you are in a box already. */
  const backToSlot = () => {
    if (isBox(document.activeElement)) return;
    if (lastSlot.current?.isConnected) lastSlot.current.focus();
    else focusBox();
  };

  /** The page's keys that move the recording: Space plays and pauses, the
   *  arrows move by word, with Shift by five seconds, and in slots Down
   *  plays the selected letter and Up its word. Whether it was one. */
  const moveKey = (ev: KeyboardEvent): boolean => {
    if (ev.key === " ") toggle();
    else if (ev.key === "ArrowLeft") {
      if (ev.shiftKey) back(5);
      else skipBack(words);
    } else if (ev.key === "ArrowRight") {
      if (ev.shiftKey) on(5);
      else seek(skipSpan(words, posRef.current, 1));
    } else if (ev.key === "ArrowDown" && input === "slots" && selected) playLetter();
    else if (ev.key === "ArrowUp" && input === "slots" && selected) playWord();
    else return false;
    ev.preventDefault();
    return true;
  };

  /* With Cmd on a Mac or Ctrl elsewhere, the page's keys work in a box, and
     Enter in a box locks its line. */
  const modKey = (ev: KeyboardEvent): boolean => {
    if (!modOf(ev)) return false;
    if (ev.key === "Enter") {
      const line = isBox(ev.target) ? ev.target.closest<HTMLElement>("li[data-line]")?.dataset.line : undefined;
      if (line === undefined) return false;
      ev.preventDefault();
      setLine(Number(line), { locked: true });
      return true;
    }
    return moveKey(ev);
  };

  /* Outside a box: Space or Enter plays and pauses, Esc pauses, and the
     arrows move by word, with Shift by five seconds. In a box, Enter plays
     and pauses, and Esc leaves it; the rest is typing. */
  const keyRef = useRef<(ev: KeyboardEvent) => void>(() => {});
  keyRef.current = (ev) => {
    if (!rec) return;
    if (modKey(ev)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const el = ev.target as HTMLElement | null;
    if (isBox(el)) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        toggle();
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
    if (el?.tagName === "BUTTON") return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      toggle();
    } else moveKey(ev);
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

  /** Your earlier attempts at line `i`, oldest first, as the setting picks
   *  them. Not while the line shows what was sent instead. */
  const pastOf = (over: Over, i: number): React.ReactElement | null => {
    if (!kept || earlier === "none" || linesShow !== "copy" || attempt === 0) return null;
    const from = earlier === "all" ? 0 : attempt - 1;
    const past = kept.attempts.slice(from, attempt);
    return (
      <span className="pastcopies">
        {past.map((a, k) => {
          const copy = a.lines[i]!;
          const g = gradeLine(over, copy, input);
          return (
            <span key={k} className="copyrow pastcopy" data-testid="copy-past">
              {input === "slots" ? (
                <SlotsPast over={over} copy={copy} />
              ) : (
                <YourMarks sent={sentText(over)} typed={plain(copy.typed)} attrs={attrsOf(over)} />
              )}
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
          // With Cmd or Ctrl, a key is the page's.
          if (ev.metaKey || ev.ctrlKey) return;
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

  /** The line playing now: the one the recording is in, or the part. */
  const nowAt = mode.current === "part" ? partAt : mode.current === "main" ? pos : null;
  const nowLine =
    rec && nowAt !== null ? rec.overs.findIndex((o, i) => nowAt >= o.t0 - 0.05 && nowAt < (rec.overs[i + 1]?.t0 ?? Infinity)) : -1;

  const status = reading
    ? "Reading the recording…"
    : !rec
      ? recalling
        ? ""
        : "Open a recording of CW to copy."
      : playing === "main"
        ? linesShow === "copy"
          ? "Type what you hear in each line."
          : "Listen along."
        : ended
          ? linesShow === "copy"
            ? perfect
              ? "You copied every line."
              : "Copy again to go once more."
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
          className={rec ? "copyopen" : "copyopen primary"}
          data-testid="copy-open"
          disabled={reading}
          title="Open a recording of CW to copy, or drop one on the page"
          onClick={pickFile}
        >
          <i className="ico">
            <IconUpload />
          </i>
          Open a recording
        </button>
        {/* Start over and Show answers are always here, so the header does
            not move. Off until there is a copy to check. */}
        <button
          data-testid="copy-restart"
          disabled={!started}
          title="Clear every attempt and go back to the start"
          onClick={restart}
        >
          Start over
        </button>
        {/* On or off, as the pages' other choices in the header are. */}
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
        {/* Always here, as on the other pages. Off while the recording plays
            or before there is one. */}
        <button
          data-testid="copy-clear"
          disabled={!rec || reading || playing !== null}
          title="Close this recording and clear every attempt"
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
          pageRow={
            <>
              <Section name="copy" title="Your copy">
                <div className="panelgroups">
                  <ChoiceGroup
                    id="copy-input"
                    label="Copy in"
                    help={INPUT_HELP}
                    value={input}
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
                </div>
              </Section>
            </>
          }
        />
      </SettingsBand>

      <main className="panel qso copy" data-testid="copy">
        <div className="copyhead" role="status" aria-live="polite">
          {state && (
            <span className="uplabel" data-testid="copy-state" data-state={state}>
              {STATE_WORDS[state]}
              {kept && kept.attempts.length > 1 && <span data-testid="copy-attempt"> · Attempt {kept.attempts.length}</span>}
            </span>
          )}
          <span className="copysay">{status}</span>
        </div>

        {rec && (
          <>
            <div className="qsocontrols">
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
              <span className="hint copyname" title={file!.name}>
                {file!.name}
              </span>
            </div>
            <div className="qsocontrols copyskips">
              <div className="modeswitch" role="group" aria-label="Back">
                {skip("‹ Line", "Back a line", () => skipBack(overs), "copy-back-line")}
                {skip("‹ 15 s", "Back 15 seconds", () => back(15), "copy-back-15")}
                {skip("‹ 5 s", "Back 5 seconds", () => back(5), "copy-back-5")}
                {skip("‹ Word", "Back a word", () => skipBack(words), "copy-back-word")}
              </div>
              <div className="modeswitch" role="group" aria-label="On">
                {skip("Word ›", "On a word", () => seek(skipSpan(words, posRef.current, 1)), "copy-on-word")}
                {skip("5 s ›", "On 5 seconds", () => on(5), "copy-on-5")}
                {skip("15 s ›", "On 15 seconds", () => on(15), "copy-on-15")}
                {skip("Line ›", "On a line", () => seek(skipSpan(overs, posRef.current, 1)), "copy-on-line")}
              </div>
              {input === "slots" && (
                <div className="modeswitch" role="group" aria-label="Play the selected slot">
                  {slotPlay("Letter", "Play the selected letter", playLetter, "copy-play-letter")}
                  {slotPlay("Word", "Play the selected word", playWord, "copy-play-word")}
                </div>
              )}
            </div>
          </>
        )}

        {!rec && !recalling && !reading && (
          <div className="qsocontrols">
            <button className="primary" data-testid="copy-open-first" onClick={pickFile}>
              <i className="ico">
                <IconUpload />
              </i>
              Open a recording
            </button>
            <span className="hint">or drop one on the page</span>
          </div>
        )}

        {!rec && !recalling && !reading && (
          <div className="qsoguide prose" data-testid="copy-guide">
            <p>Open a recording of CW and copy it as it plays. Each line you copy is checked against what was sent.</p>
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
            <p>Your recording stays in this browser.</p>
          </div>
        )}

        {rec && kept && (
          <ol className="qsolog copylog" data-testid="copy-log" ref={log} onMouseUp={onLogMouseUp}>
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
            {linesShow === "copy" && !perfect && (
              <div className="qsocontrols copyactions">
                <button
                  className={ended && locked ? "primary" : undefined}
                  data-testid="copy-again"
                  disabled={!locked && !ended}
                  title="Play the whole recording again and copy it once more"
                  onClick={again}
                >
                  Copy again
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
          accept={ACCEPTED}
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
              &nbsp;·&nbsp; <kbd>←</kbd> <kbd>→</kbd> a word &nbsp;·&nbsp; <kbd>Shift</kbd> <kbd>←</kbd> <kbd>→</kbd> 5 s
              {input === "slots" && (
                <>
                  {" "}
                  &nbsp;·&nbsp; <kbd>↓</kbd> <kbd>↑</kbd> the selected letter or word
                </>
              )}
            </p>
            <p className="legend keys" data-testid="copy-box-keys">
              In a box: <kbd>Enter</kbd> play or pause &nbsp;·&nbsp; <kbd>{MOD}</kbd> <kbd>Enter</kbd> lock the line
              &nbsp;·&nbsp; <kbd>Esc</kbd> leave the box &nbsp;·&nbsp; hold <kbd>{MOD}</kbd> for the other keys
            </p>
          </div>
        )}
      </main>
    </>
  );
}
