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
import { loadUser, recallLive, rememberLive } from "@/io/storage";
import type { Band, Signal } from "@/live/decoder";
import { logAdif, logCsv, transcriptText } from "@/live/export";
import { buildLog, NO_FIXES, type Fixes, type Line, type LiveTurn, type Qso } from "@/live/log";
import { FIELD_KEYS, KIND_LABEL, type FieldKey } from "@/live/parse";
import { PageHelp, type KeyGroup } from "./Help";
import { PageSwitch, type Page } from "./PageSwitch";
import { LevelMeter, RecDot } from "./Record";
import { MicChip, SettingsButton } from "./SettingsDrawer";
import { DownloadItem, MenuHeading, Toolbar } from "./Toolbar";
import { useListen, type OpenTurn } from "./useListen";
import { useRecorder } from "./useRecorder";
import { HomeButton } from "./Wordmark";

/** Seconds of audio the recorder keeps. The decoder reads it as it comes,
 *  so a few seconds would do; this is room to spare. */
const KEEP_SECONDS = 30;
/** The most turns the log keeps. The oldest go first. */
const MAX_TURNS = 3000;
/** The log scrolls with new lines while it is this close to its end, px. */
const END_SLACK_PX = 48;

/** A detail's name on a card. */
const FIELD_LABEL: Readonly<Record<FieldKey, string>> = {
  name: "Name",
  qth: "QTH",
  state: "State",
  rst: "Report sent",
  power: "Power",
  rig: "Rig",
  ant: "Antenna",
  number: "Number",
  park: "Park",
  skcc: "SKCC",
};

const LIVE_GUIDE = (
  <>
    <p>Live decodes any CW that comes in from your input, as it comes.</p>
    <ul>
      <li>Key into your microphone to see your own sending decoded. Or connect your radio&apos;s audio to the input to copy the band.</li>
      <li>Live finds the speed of each station by itself. The speed you set on the other pages does not apply here.</li>
      <li>Live follows up to 8 signals at once. Each line is one station&apos;s turn, with that station&apos;s call and speed.</li>
      <li>The lines of each QSO are grouped. A card beside them shows what each station sent: call, name, QTH, report and more.</li>
      <li>Live can be wrong about who sent a line. Click the call at the start of a line to change it. Click a detail on a card to correct it.</li>
      <li>Your own lines show in blue when Live reads your call from Settings › You.</li>
      <li>The log stays after a reload. Download it from ⋯ as text, as a log file for a logging program, or as a spreadsheet.</li>
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
  return { turns, fixes };
}

/** Save `text` as a file called `name`. */
function save(text: string, name: string, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A file name stem with the date: cwt-live-2026-11-21. */
function stem(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `cwt-live-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    rememberLive(kept.turns.length || Object.keys(kept.fixes.sender).length ? kept : null);
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
  const listening = useListen(recorder, calibration, addTurns);

  const myCall = loadUser().callsign;
  const log = useMemo(
    () => buildLog([...kept.turns, ...listening.open], kept.fixes, myCall),
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
  const fixField = (qsoId: string, call: string, key: FieldKey, value: string) =>
    setKept((k) => {
      const forQso = { ...(k.fixes.fields[qsoId] ?? {}) };
      forQso[call] = { ...(forQso[call] ?? {}), [key]: value.trim().toUpperCase() };
      return { ...k, fixes: { ...k.fixes, fields: { ...k.fixes.fields, [qsoId]: forQso } } };
    });
  const clear = () => setKept({ turns: [], fixes: NO_FIXES });

  const groups = useMemo(() => groupLines(log.lines), [log.lines]);
  const qsoById = useMemo(() => new Map(log.qsos.map((q) => [q.id, q])), [log.qsos]);
  const heard = listening.signals.filter((s) => s.quietSec < 20);
  const status = recorder
    ? heard.length === 0
      ? "Listening. No CW heard yet."
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
                disabled={recorder !== null || kept.turns.length === 0}
                title="Clear the log of every line and QSO"
                onClick={clear}
              >
                Clear log
              </button>
            </>
          }
          more={
            <>
              <MenuHeading>Download</MenuHeading>
              <DownloadItem
                label="Transcript"
                testId="live-download-text"
                disabled={log.lines.length === 0}
                title="Save every line as a text file"
                onClick={() => save(transcriptText(log.lines), `${stem()}.txt`, "text/plain")}
              />
              <DownloadItem
                label="Log for a logging program"
                testId="live-download-adif"
                disabled={log.qsos.length === 0}
                title="Save the QSOs as an ADIF file"
                onClick={() => save(logAdif(log.qsos, myCall, APP_VERSION), `${stem()}.adi`, "text/plain")}
              />
              <DownloadItem
                label="Log as a spreadsheet"
                testId="live-download-csv"
                disabled={log.qsos.length === 0}
                title="Save the QSOs as a CSV file"
                onClick={() => save(logCsv(log.qsos), `${stem()}.csv`, "text/csv")}
              />
            </>
          }
        />
      </header>

      <main className="panel qso live" data-testid="live">
        <div className="qsotop">
          <div className="copyhead" role="status" aria-live="polite">
            <span className="uplabel" data-testid="live-state" data-state={recorder ? "listening" : "stopped"}>
              {recorder ? "Listening" : "Stopped"}
            </span>
            <span className="copysay qsostatus">{status}</span>
          </div>
          {recorder && <BandStrip band={listening.band} signals={heard} />}
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
                              onSender={(call) => fixSender(line.turn.id, call)}
                            />
                          ))}
                        </ol>
                        {qso && <QsoCard qso={qso} onField={(call, key, value) => fixField(qso.id, call, key, value)} />}
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
 *  whose lines are broken up by another's shows once, where it started,
 *  with all its lines. */
function groupLines(lines: readonly Line[]): { qso: string | null; lines: Line[] }[] {
  const out: { qso: string | null; lines: Line[] }[] = [];
  const byQso = new Map<string, { qso: string | null; lines: Line[] }>();
  for (const line of lines) {
    const found = line.qso ? byQso.get(line.qso) : undefined;
    if (found) {
      found.lines.push(line);
      continue;
    }
    const group = { qso: line.qso, lines: [line] };
    if (line.qso) byQso.set(line.qso, group);
    out.push(group);
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
  onSender,
}: {
  line: Line;
  open: OpenTurn | null;
  calls: readonly string[];
  fixed: boolean;
  onSender(call: string | null): void;
}): React.ReactElement {
  const cls = [line.mine ? "you" : "them", open ? "live" : ""].filter(Boolean).join(" ");
  return (
    <li className={cls} data-testid="live-line" data-open={String(!!open)} data-sender={line.sender ?? ""}>
      <WhoPicker who={line.sender} calls={calls} fixed={fixed} onPick={onSender} />
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
  onPick,
}: {
  who: string | null;
  calls: readonly string[];
  fixed: boolean;
  onPick(call: string | null): void;
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
        </span>
      )}
    </span>
  );
}

/** What each station of a QSO sent, a column per station. A detail opens
 *  to be corrected with a click. */
function QsoCard({
  qso,
  onField,
}: {
  qso: Qso;
  onField(call: string, key: FieldKey, value: string): void;
}): React.ReactElement {
  const keys = FIELD_KEYS.filter((k) => qso.stations.some((s) => s.fields[k]));
  const [adding, setAdding] = useState<FieldKey | null>(null);
  const shown = adding && !keys.includes(adding) ? [...keys, adding] : keys;
  const missing = FIELD_KEYS.filter((k) => !shown.includes(k));
  return (
    <div className="qsoreport livecard" data-testid="live-card" data-kind={qso.kind ?? ""} data-ended={String(qso.ended)}>
      <p className="cardhead">
        {qso.kind && <span className="cardkind">{KIND_LABEL[qso.kind]}</span>}
        <span>{clock(qso.at)}</span>
        <span>{qso.hz} Hz</span>
        <span>{qso.ended ? "Ended" : "Going on"}</span>
      </p>
      <table>
        <tbody>
          <tr className="side">
            <th scope="col" />
            {qso.stations.map((s) => (
              <th key={s.call} scope="col" className={s.mine ? "mine" : undefined}>
                {s.call}
                {s.wpm > 0 && <span className="cardwpm"> {s.wpm} wpm</span>}
              </th>
            ))}
          </tr>
          {shown.map((k) => (
            <tr key={k}>
              <th scope="row">{FIELD_LABEL[k]}</th>
              {qso.stations.map((s) => (
                <td key={s.call}>
                  <FieldCell value={s.fields[k] ?? ""} label={`${FIELD_LABEL[k]} of ${s.call}`} onSave={(v) => onField(s.call, k, v)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {missing.length > 0 && (
        <select
          className="cardadd"
          aria-label="Add a detail"
          value=""
          onChange={(e) => setAdding(e.target.value as FieldKey)}
        >
          <option value="">Add a detail…</option>
          {missing.map((k) => (
            <option key={k} value={k}>
              {FIELD_LABEL[k]}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** One detail on a card: its value, or a box to correct it. */
function FieldCell({ value, label, onSave }: { value: string; label: string; onSave(v: string): void }): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <button
        type="button"
        className="link cardvalue"
        title={`Correct the ${label.toLowerCase()}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value || "—"}
      </button>
    );
  }
  const done = (keep: boolean) => {
    setEditing(false);
    if (keep && draft.trim().toUpperCase() !== value) onSave(draft);
  };
  return (
    <input
      className="cardinput"
      aria-label={label}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value.toUpperCase())}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      }}
    />
  );
}

/** The band from 300 to 1500 Hz as heard lately, with a mark on each signal
 *  Live follows. */
function BandStrip({ band, signals }: { band: Band | null; signals: readonly Signal[] }): React.ReactElement {
  const width = 600;
  const height = 40;
  const top = 36;
  if (!band) return <div className="livestrip" aria-hidden="true" />;
  const span = band.toHz - band.fromHz;
  const x = (hz: number) => ((hz - band.fromHz) / span) * width;
  const points = Array.from(band.db, (db, i) => {
    const hz = band.fromHz + (i / Math.max(1, band.db.length - 1)) * span;
    return `${x(hz).toFixed(1)},${(height - (Math.min(db, top) / top) * (height - 4)).toFixed(1)}`;
  }).join(" ");
  return (
    <div className="livestrip" data-testid="live-band">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points} />
      </svg>
      {signals.map((s) => (
        <span
          key={s.ch}
          className={s.keyed ? "livesig on" : "livesig"}
          style={{ left: `${(x(s.hz) / width) * 100}%` }}
          title={`${s.hz.toFixed(0)} Hz${s.wpm ? `, ${s.wpm} wpm` : ""}`}
        >
          {s.wpm > 0 ? `${s.wpm}` : ""}
        </span>
      ))}
      <span className="livescale">
        <span>{Math.round(band.fromHz)} Hz</span>
        <span>{Math.round(band.toHz)} Hz</span>
      </span>
    </div>
  );
}
