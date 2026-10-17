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
import { loadPrefs, loadSpeed, loadUser, savePrefs } from "@/io/storage";
import { DEFAULT_SPEED, answer, newQso, type Qso } from "@/qso/cq";
import type { Speed } from "@/qso/speed";
import type { Length } from "@/qso/wording";
import { gradeCopy, revealed, type TheirText, type YourText } from "@/qso/show";
import { idealTimeline } from "@/timing/timeline";
import { targetTiming } from "@/timing/model";
import { IconUser } from "./Icons";
import { PageSwitch, type Page } from "./PageSwitch";
import { LevelMeter, RecDot } from "./Record";
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
  readonly help: string;
}

const LENGTHS: ReadonlyArray<Option<Length>> = [
  { value: "full", label: "Full", help: "Each item twice, the way it is sent on the air" },
  { value: "short", label: "Short", help: "Each item once, with fewer words around it" },
  { value: "pieces", label: "Piece by piece", help: "Report, then name, then QTH, one per over" },
];

/** A labeled switch between a few options. */
function Choice<T extends string>({
  label,
  testId,
  options,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange(value: T): void;
}): React.ReactElement {
  return (
    <div className="qsochoice">
      <span className="qsochoicelabel">{label}</span>
      <div className="modeswitch" role="group" aria-label={label} data-testid={testId}>
        {options.map((m) => (
          <button
            key={m.value}
            aria-pressed={value === m.value}
            title={m.help}
            onClick={() => onChange(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const COPY_MODES: ReadonlyArray<Option<CopyMode>> = [
  {
    value: "lenient",
    label: "Lenient",
    help: "Read your sending at your own timing, and take a call with one character wrong",
  },
  {
    value: "strict",
    label: "Strict",
    help: "Read your sending at the set speed, and take only calls sent exactly",
  },
];

const THEIR_TEXTS: ReadonlyArray<Option<TheirText>> = [
  { value: "before", label: "Whole", help: "Show each over whole as soon as it starts" },
  { value: "sent", label: "As sent", help: "Show each character as it is sent" },
  { value: "hidden", label: "Blurred", help: "Show each character as it is sent, blurred" },
  { value: "copy", label: "Copy", help: "Type what you hear, and see it graded at the end of the QSO" },
  { value: "none", label: "Off", help: "Show nothing until the end of the QSO" },
];

const YOUR_TEXTS: ReadonlyArray<Option<YourText>> = [
  { value: "sent", label: "As sent", help: "Show each character as you send it" },
  { value: "hidden", label: "Blurred", help: "Show each character as you send it, blurred" },
  { value: "none", label: "Off", help: "Show nothing until the end of the QSO" },
];

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
}

/** Enter and Escape in a copy box are typing, not commands. The recorder
 *  listens on the document, and these keys would stop the session. */
function keepKeys(ev: React.KeyboardEvent): void {
  if (ev.key === "Enter" || ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
  }
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

export interface QsoScreenProps {
  deviceId: string | undefined;
  onError(message: string): void;
  onConfigure(): void;
  onPage(page: Page): void;
}

export function QsoScreen({
  deviceId,
  onError,
  onConfigure,
  onPage,
}: QsoScreenProps): React.ReactElement {
  const speed = useMemo(() => loadSpeed() ?? DEFAULT_SPEED, []);

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
  const qso = useRef<Qso>(newQso(Math.random, "", speed));
  /** Which QSO of the session is running, counted from 0. */
  const qsoNo = useRef(0);
  /** The QSOs that are over. Their overs all show. */
  const [closed, setClosed] = useState<readonly number[]>([]);
  /** A QSO that closes once the reply now playing ends. */
  const closing = useRef<number | null>(null);
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
    const n = qsoNo.current;
    setClosed((c) => (c.includes(n) ? c : [...c, n]));
  }, [recorder, quiet]);

  const source = useMemo(
    () => (recorder ? { recorder, ...speed } : null),
    [recorder, speed],
  );
  const copy = useLiveCopy(source, phase === "listening", lenient);

  afterReply.current = () => {
    timer.current = setTimeout(() => {
      timer.current = null;
      recorder?.restart();
      setPhase("listening");
      if (closing.current !== null) {
        const n = closing.current;
        closing.current = null;
        setClosed((c) => [...c, n]);
      }
      // A new station starts at your speed.
      if (!qso.current.last) setTheirSpeed(speed);
    }, AFTER_REPLY_MS);
  };

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
    setNote(turn.ended ? "The QSO is over. Call CQ for the next one." : "");
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
          { who: them.call, text: reply, you: false, qso: n, typed: "", mode: theirMode.current },
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
    qso.current = newQso(Math.random, "", speed);
    setTheirSpeed(speed);
    answered.current = -1;
    void rec.start();
  };

  const setTyped = (at: number, typed: string) =>
    setLines((l) => l.map((line, i) => (i === at ? { ...line, typed } : line)));

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
          onKeyDown={keepKeys}
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

  const status = !recorder
    ? "Press Start, then call CQ."
    : phase === "listening"
      ? "Your turn. Hand it over with K."
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
        <div className="cornergroup" inert={recorder !== null} data-locked={recorder !== null}>
          <button
            className="iconbtn cornerbtn"
            aria-label="Configuration"
            title="Configuration"
            onClick={onConfigure}
          >
            <IconUser />
          </button>
        </div>
      </header>

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
          <span className="hint">
            {wpm(speed)}, set on the practice page
            {!same(theirSpeed, speed) && (
              <>
                {" "}
                · <span data-testid="qso-their-speed">the station sends at {wpm(theirSpeed)}</span>
              </>
            )}
          </span>
        </div>

        <div className="qsooptions">
          <Choice
            label="Copy"
            testId="qso-copy"
            options={COPY_MODES}
            value={copyMode}
            onChange={setCopyMode}
          />
          <Choice
            label="Length"
            testId="qso-length"
            options={LENGTHS}
            value={length}
            onChange={setLength}
          />
          <Choice
            label="Station text"
            testId="qso-their-text"
            options={THEIR_TEXTS}
            value={theirText}
            onChange={setTheirText}
          />
          <Choice
            label="Your text"
            testId="qso-your-text"
            options={YOUR_TEXTS}
            value={yourText}
            onChange={setYourText}
          />
        </div>

        <ol className="qsolog" data-testid="qso-log">
          {lines.map((line, i) => (
            <li key={i} className={line.you ? "you" : "them"}>
              <span className="who">{whoOf(line)}</span>
              {textOf(line, i)}
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

        {note && <p className="hint qsonote">{note}</p>}

        {recorder && (
          <p className="hint">r starts your over again · enter or esc stops</p>
        )}
      </main>
    </>
  );
}
