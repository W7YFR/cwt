/* The Live page: whatever CW comes in, decoded as it comes.
 *
 * Listen opens the input and keeps it open until Stop. The decoder follows
 * every signal it finds, at each sender's own speed, and splits each signal
 * into turns. The log groups the turns into QSOs, each with a card of what its
 * stations said. A turn's sender and a card's details can be corrected by
 * hand, and the corrections stay with the log.
 *
 * The log outlives a reload. Only the turns and the corrections are kept; the
 * rest is worked out from them again.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APP_VERSION } from "@/build-info";
import { calibrationOf, profileForSource, type Profile } from "@/io/profiles";
import { loadPrefs, loadUser, recallLive, rememberLive, savePrefs } from "@/io/storage";
import type { Band, Signal } from "@/live/decoder";
import { transcriptText } from "@/live/export";
import { buildLog, NO_FIXES, type Fixes, type Line, type LiveTurn, type Qso } from "@/live/log";
import { KIND_LABEL } from "@/live/parse";
import { Tape } from "@/live/tape";
import { vocabulary } from "@/qso/vocabulary";
import { encodeWav } from "@/audio/wav";
import { micDebugOn, micTranscript } from "@/micdebug";
import { PageHelp, type KeyGroup } from "./Help";
import { IconCheck } from "./Icons";
import { PageSwitch, type Page } from "./PageSwitch";
import { LevelMeter, RecDot } from "./Record";
import { Check, SoundSection } from "./Controls";
import { fmtGain } from "./format";
import { MicChip, PageSettings, SettingsButton } from "./SettingsDrawer";
import { DownloadItem, MenuHeading, MoreMenu, QuickChip, Toolbar } from "./Toolbar";
import { useListen, type OpenTurn } from "./useListen";
import { useRecorder } from "./useRecorder";
import { HomeButton } from "./Wordmark";

/** Seconds of audio the recorder keeps. The decoder reads it as it comes,
 *  so a few seconds would do; this is room to spare. */
const KEEP_SECONDS = 30;
/** One QSO's recording starts this long before its first line and ends
 *  this long after its last, ms. */
const QSO_PAD_MS = 1000;
/** What Pass thru does, and the one way it goes wrong. */
const HEAR_HELP =
  "Plays your input through your speakers or headphones while Live listens, at the Volume. " +
  "With a microphone as the input, use headphones: the microphone would hear the speakers.";
/** A signal quiet this long is no longer counted in the status, seconds. */
const QUIET_SHOWN_SEC = 20;
/** The narrowest range of pitches a drag on the band chooses, Hz. */
const MIN_RANGE_HZ = 40;
/** Minutes of audio kept for the Recording download. */
const TAPE_MINUTES = 30;
/** The most turns the log keeps. The oldest go first. */
const MAX_TURNS = 3000;
/** The log scrolls with new lines while it is this close to its end, px. */
const END_SLACK_PX = 48;

const LIVE_GUIDE = (
  <>
    <p>Live decodes any CW that comes in from your input, as it comes.</p>
    <ul>
      <li>Key into your microphone to see your own sending decoded. Or connect your radio&apos;s audio to the input to copy the band.</li>
      <li>Live finds the speed of each station by itself. The speed you set on the other pages does not apply here.</li>
      <li>Live follows up to 8 signals at once. Each line is one station&apos;s turn, with that station&apos;s call and speed.</li>
      <li>The band under the heading shows how far each pitch stands over the noise. Each signal Live follows is a line, with its pitch. To decode only some pitches, drag across the band, from a little below a signal&apos;s line to a little above it. Live leaves signals outside them alone. Double-click the band, or click Decode all, to decode the whole band again.</li>
      <li>The lines of each QSO are grouped. A card beside them shows the QSO&apos;s time, pitch and stations.</li>
      <li>To note the radio&apos;s frequency, open ⋯ on a QSO&apos;s card and choose Frequency. Later QSOs take the same frequency until you type a new one.</li>
      <li>Live can be wrong about who sent a line. Click the call at the start of a line to change it.</li>
      <li>To make a call stick, click it at the start of a line and choose Confirm. Live then reads calls close to it as that call, and lines at that pitch as sent by that station. A check mark shows beside a confirmed call on its cards.</li>
      <li>Your own lines show in blue when Live reads your call from Settings › You.</li>
      <li>The log stays after a reload. Download it as text from ⋯.</li>
      <li>To hear your input as Live decodes it, open Pass thru and tick Pass thru. With a microphone as the input, use headphones.</li>
      <li>From ⋯, Audio saves the latest 30 minutes Live heard, as a WAV file. The audio does not stay after a reload.</li>
      <li>⋯ on a QSO&apos;s card downloads just that QSO, as audio or text. Its audio is there only while the QSO is within the latest 30 minutes.</li>
    </ul>
  </>
);

const LIVE_KEYS: readonly KeyGroup[] = [
  {
    heading: "On the page",
    rows: [
      { keys: [["R"]], does: "Listen" },
      { keys: [["Enter"], ["Esc"]], does: "Stop listening" },
    ],
  },
];

interface Kept {
  turns: LiveTurn[];
  fixes: Fixes;
  /** The pitches to decode, Hz, or absent for the whole band. */
  range?: readonly [number, number];
  /** The input plays through the speakers while Live listens. */
  hear?: boolean;
}

/** The log as last remembered, checked loosely: a turn needs its text and
 *  its times. */
function recalled(): Kept {
  const raw = recallLive() as Partial<Kept> | null;
  const turns = Array.isArray(raw?.turns)
    ? raw.turns.filter(
        (t): t is LiveTurn =>
          !!t && typeof t.id === "string" && typeof t.text === "string" && typeof t.at === "number" && typeof t.chan === "string",
      )
    : [];
  const fixes = raw?.fixes && typeof raw.fixes === "object" ? { ...NO_FIXES, ...raw.fixes } : NO_FIXES;
  const r = raw?.range;
  const range = Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === "number") && r[0]! < r[1]! ? ([r[0]!, r[1]!] as const) : undefined;
  const hear = raw?.hear === true;
  return { turns, fixes, ...(range ? { range } : {}), ...(hear ? { hear } : {}) };
}

/** Save `data` as a file called `name`. */
function save(data: string | Blob, name: string, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(typeof data === "string" ? new Blob([data], { type }) : data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A file name stem with the date, today or at `at` (ms): cwt-live-2026-11-21. */
function stem(at = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `cwt-live-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A file name stem for one QSO: its date, its start in UTC and its first
 *  station, cwt-live-2026-11-21-0247Z-W1AW-5. */
function qsoStem(qso: Qso): string {
  const call = qso.stations[0]?.call.replace(/\//g, "-");
  return `${stem(qso.at)}-${utcClock(qso.at)}${call ? `-${call}` : ""}`;
}

/** A time of day, UTC, as the transcript gives it: 0247Z. */
function utcClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}

/** A time of day, local: 18:04. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function LiveScreen({
  deviceId,
  profiles,
  profileId,
  onError,
  onPage,
  onHome,
}: {
  deviceId: string | undefined;
  profiles: readonly Profile[];
  profileId: string | undefined;
  onError(message: string): void;
  onPage(page: Page): void;
  onHome(): void;
}): React.ReactElement {
  const [kept, setKept] = useState<Kept>(recalled);
  const keptRef = useRef(kept);
  keptRef.current = kept;
  useEffect(() => {
    rememberLive(kept.turns.length || Object.keys(kept.fixes.sender).length || kept.range || kept.hear ? kept : null);
  }, [kept]);

  const rec = useRecorder({
    deviceId,
    onClip: () => {},
    onError,
    startKey: true,
    maxSeconds: Infinity,
    keepSeconds: KEEP_SECONDS,
    onEnterKey: () => void stopRef.current(),
  });
  const recorder = rec.recorder;
  const stopRef = useRef(rec.discard);
  stopRef.current = rec.discard;

  const calibration = useMemo(() => {
    const profile = profileForSource(profiles.find((p) => p.id === profileId) ?? null, true);
    return profile ? calibrationOf(profile) : null;
  }, [profiles, profileId]);

  const addTurns = useCallback((turns: LiveTurn[]) => {
    setKept((k) => {
      const all = [...k.turns, ...turns];
      return { ...k, turns: all.length > MAX_TURNS ? all.slice(all.length - MAX_TURNS) : all };
    });
  }, []);
  const user = loadUser();
  const myCall = user.callsign;
  const confirmed = kept.fixes.confirmed ?? {};
  const confirmedKey = Object.keys(confirmed).sort().join(" ");
  const words = useMemo(
    () => vocabulary([user.callsign, user.name, user.qthCity, user.qthRegionShort, user.cwopsNumber, confirmedKey]),
    [user.callsign, user.name, user.qthCity, user.qthRegionShort, user.cwopsNumber, confirmedKey],
  );
  const [tape] = useState(() => new Tape(TAPE_MINUTES * 60));
  const listening = useListen(recorder, calibration, words, addTurns, tape, KEEP_SECONDS, kept.range ?? null);
  /* Pass thru, the input to the speakers: on or off here, at the Volume
     every page shares. */
  const [gainDb, setGainDbRaw] = useState(() => loadPrefs().gainDb ?? 0);
  const setGainDb = (next: number) => {
    setGainDbRaw(next);
    savePrefs({ ...loadPrefs(), gainDb: next });
  };
  const hear = kept.hear === true;
  const setHear = (on: boolean) =>
    setKept((k) => {
      const { hear: _old, ...rest } = k;
      return on ? { ...rest, hear: true } : rest;
    });
  useEffect(() => {
    recorder?.monitor?.(hear ? 10 ** (gainDb / 20) : 0);
  }, [recorder, hear, gainDb]);
  const soundSection = (
    <SoundSection gainDb={gainDb} onGainDb={setGainDb}>
      <Check id="live-passthru" label="Pass thru" help={HEAR_HELP} checked={hear} onChange={setHear} />
    </SoundSection>
  );
  const setRange = (range: readonly [number, number] | null) =>
    setKept((k) => {
      const { range: _old, ...rest } = k;
      return range ? { ...rest, range } : rest;
    });

  const log = useMemo(
    () => buildLog([...kept.turns, ...listening.open], kept.fixes, myCall, new Set(listening.open.map((t) => t.id))),
    [kept, listening.open, myCall],
  );
  const openIds = useMemo(() => new Map(listening.open.map((t) => [t.id, t])), [listening.open]);

  /* The log follows new lines while you are at its end, and stays put
     while you read further up. */
  const logBox = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    const box = logBox.current;
    if (box && atEnd.current) box.scrollTop = box.scrollHeight;
  }, [log]);

  const fixSender = (turnId: string, call: string | null) =>
    setKept((k) => {
      const sender = { ...k.fixes.sender };
      if (call) sender[turnId] = call;
      else delete sender[turnId];
      return { ...k, fixes: { ...k.fixes, sender } };
    });
  const fixFreq = (qsoId: string, value: string) =>
    setKept((k) => ({ ...k, fixes: { ...k.fixes, freq: { ...(k.fixes.freq ?? {}), [qsoId]: value.trim() } } }));
  const confirm = (call: string, hz: number | null) =>
    setKept((k) => {
      const next = { ...(k.fixes.confirmed ?? {}) };
      if (hz === null) delete next[call];
      else next[call] = hz;
      return { ...k, fixes: { ...k.fixes, confirmed: next } };
    });
  const clear = () => {
    tape.clear();
    // The range and hearing the input are how you listen, not part of the
    // log: they stay.
    setKept((k) => ({ turns: [], fixes: NO_FIXES, ...(k.range ? { range: k.range } : {}), ...(k.hear ? { hear: k.hear } : {}) }));
  };
  const saveQsoAudio = (qso: Qso) => {
    const { samples, rate } = tape.audio(qso.at - QSO_PAD_MS, qso.end + QSO_PAD_MS);
    if (samples.length) save(encodeWav(samples, rate), `${qsoStem(qso)}.wav`, "audio/wav");
  };
  const saveTape = () => {
    const at = tape.startedAt;
    if (at === null) return;
    const { samples, rate } = tape.audio();
    save(encodeWav(samples, rate), `${stem()}-${utcClock(at)}.wav`, "audio/wav");
  };

  const groups = useMemo(() => groupLines(log.lines), [log.lines]);
  const qsoById = useMemo(() => new Map(log.qsos.map((q) => [q.id, q])), [log.qsos]);
  /** Something was heard since Listen was pressed. */
  const heardSince = useRef(false);
  if (!recorder) heardSince.current = false;
  else if (listening.signals.length > 0) heardSince.current = true;
  const heard = listening.signals.filter((s) => s.quietSec < QUIET_SHOWN_SEC);
  const status = recorder
    ? heard.length === 0
      ? heardSince.current
        ? "Listening for the next station."
        : "Listening. No CW heard yet."
      : heard.length === 1
        ? "Listening. Following 1 signal."
        : `Listening. Following ${heard.length} signals.`
    : log.lines.length
      ? "Stopped. Press Listen to go on."
      : "Press Listen to decode any CW that comes in from your input.";

  return (
    <>
      <header>
        <HomeButton onHome={onHome} disabled={recorder !== null} />
        <PageSwitch page="live" onPage={onPage} disabled={recorder !== null} />
        <div className="cornergroup">
          <MicChip devices={rec.devices} deviceId={deviceId} profiles={profiles} profileId={profileId} />
          <PageHelp title="Live" guide={LIVE_GUIDE} keys={LIVE_KEYS} />
          <SettingsButton />
        </div>

        <Toolbar
          actions={
            <>
              {rec.needAccess ? (
                <button className="primary" disabled={rec.blocked} onClick={() => void rec.grantAccess()}>
                  Allow the microphone
                </button>
              ) : !recorder ? (
                <button
                  className="primary"
                  data-testid="live-start"
                  disabled={rec.probing || rec.blocked || rec.busy}
                  onClick={() => void rec.start()}
                >
                  <RecDot /> Listen
                </button>
              ) : (
                <>
                  <button data-testid="live-stop" onClick={() => void rec.discard()}>
                    Stop
                  </button>
                  <LevelMeter level={rec.level} />
                </>
              )}
              <button
                data-testid="live-clear"
                disabled={recorder !== null || (kept.turns.length === 0 && !tape.heldSec)}
                title="Clear the log of every line and QSO"
                onClick={clear}
              >
                Clear log
              </button>
            </>
          }
          chips={
            <QuickChip id="passthru" label="Pass thru" value={hear ? fmtGain(gainDb).trim() : "Off"} widest="+42 dB" tab="sound">
              {soundSection}
            </QuickChip>
          }
          more={
            <>
              <MenuHeading>Download</MenuHeading>
              <DownloadItem
                label="Text"
                testId="live-download-text"
                disabled={log.lines.length === 0}
                title="Save every line as a text file"
                onClick={() => save(transcriptText(log.lines, log.qsos), `${stem()}.txt`, "text/plain")}
              />
              <DownloadItem
                label="Audio"
                testId="live-download-audio"
                disabled={!tape.heldSec}
                title={`Save the latest ${TAPE_MINUTES} minutes Live heard as a WAV file`}
                onClick={saveTape}
              />
              {micDebugOn() && (
                <DownloadItem
                  label="Debug log"
                  testId="live-download-debug"
                  title="Save what Live and the microphone did, as a text file"
                  onClick={() =>
                    save(
                      [`cwt ${APP_VERSION}`, `page ${location.href}`, `agent ${navigator.userAgent}`, "", micTranscript(), ""].join("\n"),
                      `${stem()}-debug.txt`,
                      "text/plain",
                    )
                  }
                />
              )}
            </>
          }
        />
      </header>

      <PageSettings
        tabs={[
          {
            id: "sound",
            label: "Sound",
            scope: "Pass thru is only on the Live page. Volume is the same on every page.",
            content: soundSection,
          },
        ]}
      />

      <main className="panel qso live" data-testid="live">
        <div className="qsotop">
          <div className="copyhead" role="status" aria-live="polite">
            <span className="uplabel" data-testid="live-state" data-state={recorder ? "listening" : "stopped"}>
              {recorder ? "Listening" : "Stopped"}
            </span>
            <span className="copysay qsostatus">{status}</span>
          </div>
          {recorder && <BandStrip band={listening.band} signals={heard} range={kept.range ?? null} onRange={setRange} />}
        </div>

        <div className="qsobody">
          <div
            className="qsomain"
            ref={logBox}
            onScroll={(e) => {
              const box = e.currentTarget;
              atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < END_SLACK_PX;
            }}
          >
            {log.lines.length === 0 ? (
              <p className="hint" data-testid="live-empty">
                Nothing decoded yet. Each station&apos;s turn shows here as a line once Live hears it.
              </p>
            ) : (
              <ol className="qsolog livelog" data-testid="live-log">
                {groups.map((group, g) => {
                  const qso = group.qso ? qsoById.get(group.qso) : undefined;
                  return (
                    <Fragment key={group.lines[0]!.turn.id}>
                      <li className="qsogroup" data-qso={group.qso ?? ""}>
                        <ol className="qsolines">
                          {group.lines.map((line) => (
                            <LineItem
                              key={line.turn.id}
                              line={line}
                              open={openIds.get(line.turn.id) ?? null}
                              calls={qso?.stations.map((s) => s.call) ?? []}
                              fixed={kept.fixes.sender[line.turn.id] !== undefined}
                              confirmed={line.sender !== null && confirmed[line.sender] !== undefined}
                              onSender={(call) => fixSender(line.turn.id, call)}
                              onConfirm={(yes) => line.sender && confirm(line.sender, yes ? line.turn.hz : null)}
                            />
                          ))}
                        </ol>
                        {qso && group.last && (
                          <QsoCard
                            qso={qso}
                            hasAudio={tape.holds(qso.at - QSO_PAD_MS, qso.end + QSO_PAD_MS)}
                            onSaveAudio={() => saveQsoAudio(qso)}
                            onSaveText={() =>
                              save(
                                transcriptText(log.lines.filter((l) => l.qso === qso.id), [qso]),
                                `${qsoStem(qso)}.txt`,
                                "text/plain",
                              )
                            }
                            onFreq={(value) => fixFreq(qso.id, value)}
                          />
                        )}
                      </li>
                      {g < groups.length - 1 && <li className="qsodivider" role="separator" />}
                    </Fragment>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

/** The lines in the order they started, in runs of one QSO each. A QSO
 *  that goes on after another QSO's lines starts a new run at the end, so
 *  the log only ever grows at the bottom. `last` marks a QSO's latest run,
 *  which shows its card. */
function groupLines(lines: readonly Line[]): { qso: string | null; lines: Line[]; last: boolean }[] {
  const out: { qso: string | null; lines: Line[]; last: boolean }[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && prev.qso === line.qso) prev.lines.push(line);
    else out.push({ qso: line.qso, lines: [line], last: false });
  }
  const seen = new Set<string | null>();
  for (let i = out.length - 1; i >= 0; i--) {
    const group = out[i]!;
    group.last = !seen.has(group.qso);
    seen.add(group.qso);
  }
  return out;
}

/** One station's turn: who sent it, what it said, and its speed. The call
 *  opens a list to change who sent it. */
function LineItem({
  line,
  open,
  calls,
  fixed,
  confirmed,
  onSender,
  onConfirm,
}: {
  line: Line;
  open: OpenTurn | null;
  calls: readonly string[];
  fixed: boolean;
  confirmed: boolean;
  onSender(call: string | null): void;
  onConfirm(yes: boolean): void;
}): React.ReactElement {
  const cls = [line.mine ? "you" : "them", open ? "live" : ""].filter(Boolean).join(" ");
  return (
    <li className={cls} data-testid="live-line" data-open={String(!!open)} data-sender={line.sender ?? ""}>
      <WhoPicker who={line.sender} calls={calls} fixed={fixed} confirmed={confirmed} onPick={onSender} onConfirm={onConfirm} />
      <span className="text">
        {line.turn.text}
        {open?.keying && <span className="keying"> {open.keying}</span>}
      </span>
      <span className="lend">
        {line.turn.wpm > 0 && (
          <span className="lwpm" data-testid="live-line-wpm">
            {line.turn.wpm} wpm
          </span>
        )}
      </span>
    </li>
  );
}

/** The call at the start of a line, which opens a list of the QSO's
 *  stations to say who sent it. */
function WhoPicker({
  who,
  calls,
  fixed,
  confirmed,
  onPick,
  onConfirm,
}: {
  who: string | null;
  calls: readonly string[];
  fixed: boolean;
  confirmed: boolean;
  onPick(call: string | null): void;
  onConfirm(yes: boolean): void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (call: string | null) => {
    setOpen(false);
    onPick(call);
  };
  return (
    <span className="who livewho" ref={root}>
      <button
        type="button"
        className="link"
        data-testid="live-who"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Change who sent this line"
        onClick={() => setOpen((o) => !o)}
      >
        {who ?? "?"}
      </button>
      {open && (
        <span className="quickpop menu" role="menu">
          {calls.map((c) => (
            <button key={c} type="button" role="menuitem" onClick={() => pick(c)}>
              {c}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const typed = window.prompt("The call of the station that sent this line")?.trim().toUpperCase();
              if (typed) pick(typed);
              else setOpen(false);
            }}
          >
            Another call…
          </button>
          {fixed && (
            <button type="button" role="menuitem" onClick={() => pick(null)}>
              Let Live decide
            </button>
          )}
          {who && (
            <button
              type="button"
              role="menuitem"
              data-testid="live-confirm"
              title={
                confirmed
                  ? `Live goes back to reading ${who} like any other call`
                  : `Live reads calls close to ${who} as ${who}, and lines at this pitch as sent by ${who}`
              }
              onClick={() => {
                setOpen(false);
                onConfirm(!confirmed);
              }}
            >
              {confirmed ? `Unconfirm ${who}` : `Confirm ${who}`}
            </button>
          )}
        </span>
      )}
    </span>
  );
}

/** ⋯ on a QSO's card: its downloads, and the radio's frequency to note. */
function QsoMenu({
  hasAudio,
  onFreq,
  onSaveAudio,
  onSaveText,
}: {
  /** Its audio is still on the recording. */
  hasAudio: boolean;
  onFreq(): void;
  onSaveAudio(): void;
  onSaveText(): void;
}): React.ReactElement {
  return (
    <MoreMenu label="More for this QSO" testId="live-qso-more" up>
      <MenuHeading>Download</MenuHeading>
      <DownloadItem
        label="Audio"
        testId="live-qso-audio"
        disabled={!hasAudio}
        title={hasAudio ? undefined : `Audio is kept for the latest ${TAPE_MINUTES} minutes heard since the page loaded`}
        onClick={onSaveAudio}
      />
      <DownloadItem label="Text" testId="live-qso-text" onClick={onSaveText} />
      <MenuHeading>Note</MenuHeading>
      <button type="button" role="menuitem" data-testid="live-note-freq" onClick={onFreq}>
        Frequency
      </button>
    </MoreMenu>
  );
}

/** A QSO's card: what is known of it and its ⋯, then its stations. */
function QsoCard({
  qso,
  hasAudio,
  onSaveAudio,
  onSaveText,
  onFreq,
}: {
  qso: Qso;
  /** Its audio is still on the recording. */
  hasAudio: boolean;
  onSaveAudio(): void;
  onSaveText(): void;
  onFreq(value: string): void;
}): React.ReactElement {
  const [noting, setNoting] = useState(false);
  const facts = [qso.kind ? KIND_LABEL[qso.kind] : null, clock(qso.at), `${qso.hz} Hz`, qso.freq].filter(Boolean).join(" · ");
  return (
    <div className="qsoreport livecard" data-testid="live-card" data-kind={qso.kind ?? ""}>
      <div className="cardhead">
        <span className="cardname">{facts}</span>
        <QsoMenu hasAudio={hasAudio} onFreq={() => setNoting(true)} onSaveAudio={onSaveAudio} onSaveText={onSaveText} />
      </div>
      {noting && (
        <p className="cardfreq" data-testid="live-freq">
          <FreqBox value={qso.freq ?? ""} onSave={onFreq} onClose={() => setNoting(false)} />
        </p>
      )}
      <p className="cardcalls">
        {qso.stations.map((st) => (
          <span key={st.call} className={st.mine ? "mine" : undefined} data-confirmed={String(st.confirmed)}>
            {st.call}
            {st.confirmed && (
              <span className="cardsure" title={`You confirmed ${st.call}`}>
                {" "}
                <IconCheck />
              </span>
            )}
          </span>
        ))}
      </p>
    </div>
  );
}

/** The box the radio's frequency is typed in. Enter or leaving it keeps
 *  what is typed, and Escape lets it go. */
function FreqBox({ value, onSave, onClose }: { value: string; onSave(v: string): void; onClose(): void }): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const done = (keep: boolean) => {
    if (keep && draft.trim() !== value) onSave(draft);
    onClose();
  };
  return (
    <input
      type="text"
      aria-label="The radio's frequency"
      placeholder="Such as 14.025"
      title="Later QSOs take the same frequency until you type a new one."
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        // Enter and Escape are this box's, not the page's: they would stop
        // listening.
        if (e.key !== "Enter" && e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        done(e.key === "Enter");
      }}
    />
  );
}

/** The band from 300 to 1500 Hz as heard lately: how far each pitch stands
 *  over its noise, 0 to 36 dB, with a mark on each signal Live follows.
 *  Dragging across it chooses the pitches to decode; outside them it is
 *  dimmed. */
function BandStrip({
  band,
  signals,
  range,
  onRange,
}: {
  band: Band | null;
  signals: readonly Signal[];
  range: readonly [number, number] | null;
  onRange(range: readonly [number, number] | null): void;
}): React.ReactElement {
  const width = 600;
  const height = 40;
  const top = 36;
  const box = useRef<HTMLDivElement>(null);
  /** The drag under way: where it started and where it is now, Hz. */
  const [drag, setDrag] = useState<readonly [number, number] | null>(null);
  if (!band) return <div className="livestrip" aria-hidden="true" />;
  const span = band.toHz - band.fromHz;
  const x = (hz: number) => ((hz - band.fromHz) / span) * width;
  const pct = (hz: number) => `${(x(hz) / width) * 100}%`;
  const hzAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return band.fromHz + f * span;
  };
  const points = Array.from(band.db, (db, i) => {
    const hz = band.fromHz + (i / Math.max(1, band.db.length - 1)) * span;
    return `${x(hz).toFixed(1)},${(height - (Math.min(db, top) / top) * (height - 4)).toFixed(1)}`;
  }).join(" ");
  const shown = drag ? ([Math.min(drag[0], drag[1]), Math.max(drag[0], drag[1])] as const) : range;
  return (
    <div className="livestrip" data-testid="live-band">
      <div
        className="livebandarea"
        ref={box}
        title="Drag across the band to decode only those pitches"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const hz = hzAt(e.clientX);
          setDrag([hz, hz]);
        }}
        onPointerMove={(e) => {
          if (drag) setDrag([drag[0], hzAt(e.clientX)]);
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          const lo = Math.round(Math.min(drag[0], hzAt(e.clientX)));
          const hi = Math.round(Math.max(drag[0], hzAt(e.clientX)));
          setDrag(null);
          // A click, not a drag, leaves the range as it is.
          if (hi - lo >= MIN_RANGE_HZ) onRange([lo, hi]);
        }}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={() => onRange(null)}
      >
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          <polyline points={points} />
        </svg>
        {shown && (
          <>
            <span className="liveshade" style={{ left: 0, width: pct(shown[0]) }} />
            <span className="liveshade" style={{ left: pct(shown[1]), right: 0 }} />
          </>
        )}
        {signals.map((s) => (
          <span key={s.ch} className="livesig" style={{ left: pct(s.hz) }} title={`A signal Live follows, at ${s.hz.toFixed(0)} Hz`}>
            {s.hz.toFixed(0)} Hz
          </span>
        ))}
      </div>
      <span className="livescale">
        <span>{Math.round(band.fromHz)} Hz</span>
        {shown && (
          <span data-testid="live-range">
            Decoding {Math.round(shown[0])}–{Math.round(shown[1])} Hz
            {!drag && (
              <>
                {" · "}
                <button type="button" className="link" data-testid="live-range-all" onClick={() => onRange(null)}>
                  Decode all
                </button>
              </>
            )}
          </span>
        )}
        <span>{Math.round(band.toHz)} Hz</span>
      </span>
    </div>
  );
}
