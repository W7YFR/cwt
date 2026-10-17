/* The QSO page: call CQ, and work the station that answers.
 *
 * One recording runs for the whole session. Each over you send is copied
 * live, and when you hand the turn over, the script in qso/ answers it and
 * the answer plays. While it plays, the microphone is not copied, so the
 * reply coming back through the speakers is not read as your sending. When
 * it ends, the recording starts over, and the next over is yours.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPlayer } from "@/audio/player";
import { loadPrefs, loadSpeed, loadUser, savePrefs } from "@/io/storage";
import { DEFAULT_SPEED, answer, newQso, type Qso } from "@/qso/cq";
import type { Speed } from "@/qso/speed";
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

const COPY_MODES: ReadonlyArray<{ value: CopyMode; label: string; help: string }> = [
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

interface Line {
  readonly who: string;
  readonly text: string;
  /** Sent by you, as copied. */
  readonly you: boolean;
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
  const [note, setNote] = useState("");
  const [copyMode, setCopyModeRaw] = useState<CopyMode>(() => loadPrefs().qsoCopy ?? "lenient");
  const setCopyMode = (mode: CopyMode) => {
    setCopyModeRaw(mode);
    savePrefs({ ...loadPrefs(), qsoCopy: mode });
  };
  const lenient = copyMode === "lenient";
  const qso = useRef<Qso>(newQso(Math.random, "", speed));
  /** How fast the station sends, after QRS or QRQ. */
  const [theirSpeed, setTheirSpeed] = useState<Speed>(speed);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const afterReply = useRef<() => void>(() => {});
  /** The last over answered. */
  const answered = useRef(-1);

  const player = useMemo(
    () => createPlayer({ onEnded: (reason) => reason === "done" && afterReply.current() }),
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

  // Stopping the session stops the reply too.
  useEffect(() => {
    if (!recorder) quiet();
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
    });
    const them = turn.qso.them;
    const sent: Line = { who: turn.qso.you || "You", text: heard, you: true };

    qso.current = turn.ended ? newQso(Math.random, turn.qso.you, speed) : turn.qso;
    const at = turn.qso.speed;
    setLines((l) => [...l, sent]);

    if (turn.reply === null) {
      setNote("No answer. Call CQ again.");
      recorder.restart();
      return;
    }

    const reply = turn.reply;
    setNote(turn.ended ? "The QSO is over. Call CQ for the next one." : "");
    setPhase("waiting");
    const [lo, hi] = REPLY_DELAY_SEC;
    timer.current = setTimeout(
      () => {
        timer.current = null;
        setPhase("playing");
        setLines((l) => [...l, { who: them.call, text: reply, you: false }]);
        setTheirSpeed(at);
        player.playTarget(idealTimeline(reply, targetTiming(at.charWpm, at.farnsworthWpm)), {
          peak: 0.5,
          padSec: 0.1,
          voice: { toneHz: them.toneHz, filterQ: 3 },
        });
      },
      (lo + Math.random() * (hi - lo)) * 1000,
    );
  }, [copy.over, copy.text, copy.turn, phase, recorder, player, speed, lenient]);

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
    qso.current = newQso(Math.random, "", speed);
    setTheirSpeed(speed);
    answered.current = -1;
    void rec.start();
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
          <div className="modeswitch" role="group" aria-label="Copy" data-testid="qso-copy">
            {COPY_MODES.map((m) => (
              <button
                key={m.value}
                aria-pressed={copyMode === m.value}
                title={m.help}
                onClick={() => setCopyMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
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

        <ol className="qsolog" data-testid="qso-log">
          {lines.map((line, i) => (
            <li key={i} className={line.you ? "you" : "them"}>
              <span className="who">{line.who}</span>
              <span className="text">{line.text || "(nothing copied)"}</span>
            </li>
          ))}
          {/* Not an over already answered: after a reply, the last one is
              still the copy until the recording starts over. */}
          {recorder &&
            phase === "listening" &&
            copy.turn !== answered.current &&
            (copy.text || copy.keying) && (
            <li className="you live">
              <span className="who">{qso.current.you || "You"}</span>
              <span className="text">
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
