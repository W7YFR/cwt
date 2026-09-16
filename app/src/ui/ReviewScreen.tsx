/* The review: header, controls, chart, downloads, report.
 *
 * This is where the imperative parts (audio, canvas) meet the declarative ones.
 * The rule that keeps it manageable: React owns the settings and the focus, the
 * player owns the transport, the chart owns the viewport, and none of them
 * reaches into another's state. The playhead is the one thing that crosses —
 * the player produces it and the chart consumes it — and it goes through a ref
 * rather than through state, because sixty re-renders a second to move one line
 * would make everything else stutter.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPlayer, type PlaySide, type Player } from "@/audio/player";
import { encodeWav } from "@/audio/wav";
import { buildJsonReport } from "@/io/report";
import { contextWindow, type Focus } from "@/render/focus";
import { PACED_STOP_AFTER_SEC, PLAY_PAD } from "@/render/geometry";
import type { Profile } from "@/io/profiles";
import type { Review, ReviewSettings } from "@/types";
import type { AudioClip } from "@/types";
import { ChartView, type ChartHandle } from "./Chart";
import { ChartSettingsButton, ChartSettingsPanel, Controls, ViewControls } from "./Controls";
import { FlashCard } from "./FlashCard";
import { beatsFor, pacedEnd, pacedStart, wordsFor, type Word } from "./pacing";
import { RecordBar } from "./Record";
import { Report } from "./Report";
import { Scores } from "./Scores";
import { APP_NAME, Brandmark } from "./Wordmark";
import { visitWordmark } from "./wordmarks";
import { MIC_SOURCE, blankTake, isBlankTake } from "@/io/take";
import { reviewTake } from "@/timing";
import { recentCount, runOrder } from "./runOrder";
import { NewSession } from "./NewSession";
import { baseName } from "./format";
import { useRecorder } from "./useRecorder";
import type { LoadedTake } from "./useTake";

export interface ReviewScreenProps {
  loaded: LoadedTake;
  review: Review;
  /** Every attempt in this session, oldest first, all against one target. */
  stack: readonly Review[];
  selected: number;
  onSelectRun(i: number): void;
  /** Throw away one attempt and keep the rest. */
  onDropRun(i: number): void;
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  /* Recording again without leaving: having just seen where your spacing
     drifted, the next thing you want is another go at the same text, with the
     speeds and tolerance you have already dialed in still set. */
  onAudio(
    clip: AudioClip,
    source: string,
    fromMic: boolean,
    data: ArrayBuffer | null,
  ): void;
  onError(message: string): void;
  deviceId: string | undefined;
  /** Saved calibrations, which one is in use, and how to change it.
   *
   * Changing it does two things and both are wanted: it becomes the
   * calibration the next recording is made under, and every recording already
   * in the session is read again through it. */
  profiles: readonly Profile[];
  profileId: string | undefined;
  onProfileChange(id: string | undefined): Promise<void> | void;
  onDeviceChange(id: string | undefined): void;
  /** Into the calibration wizard, and back here afterwards. */
  onCalibrate(): void;
  /** Drop the recording and stay here — see useTake.reset. */
  onClear(): void;
  /** Open a recording from disk — the same path a dropped file takes. */
  onFile(file: File): void;
  /** Start over at a new message and a new speed. */
  onNewSession(next: {
    expected: string;
    charWpm: number;
    farnsworthWpm: number;
  }): void;
  onBack(): void;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** One array, so "no preview" is a stable prop and not a fresh identity on
 *  every render — the card's effect restarts whenever `words` changes. */
const EMPTY_WORDS: readonly Word[] = [];

export function ReviewScreen({
  loaded,
  review,
  stack,
  selected,
  onSelectRun,
  onDropRun,
  settings,
  onChange,
  onAudio,
  onError,
  deviceId,
  profiles,
  profileId,
  onProfileChange,
  onDeviceChange,
  onCalibrate,
  onClear,
  onFile,
  onNewSession,
  onBack,
}: ReviewScreenProps): React.ReactElement {
  /* Declared before the recorder because the recorder's R key is turned off
     while the dialog is up: a key that starts a recording behind an open
     dialog answers a question nobody asked. */
  const [starting, setStarting] = useState(false);
  /* Whether the chart settings are on show. Not a setting itself: it is where
     you are looking rather than anything about the chart, and it has no
     business outliving the page or riding along in a saved report. */
  const [chartSettings, setChartSettings] = useState(false);

  const rec = useRecorder({
    deviceId,
    onClip: useCallback(
      (clip: AudioClip) => onAudio(clip, MIC_SOURCE, true, null),
      [onAudio],
    ),
    onError,
    startKey: !starting,
  });

  const [focus, setFocus] = useState<Focus | null>(null);
  const [playing, setPlaying] = useState<PlaySide | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  /* Nothing recorded into this session yet. The target half of the review
     works without one — that is the point of it — but everything that reads
     the recording has to say so rather than act on an empty one. */
  const blank = isBlankTake(loaded.take);

  /* What the chart shows while a recording is running: the target, the cursor,
     and one empty row for what is arriving.
     
     The rest of the session comes off. With a paddle in your hand the earlier
     attempts are not something you can act on — they are just rows between
     your eye and the cursor, and the cursor is the only thing on the chart
     that is about the next second. They come back the moment you stop, with
     the new attempt among them.
     
     A blank take rather than an empty list, so the row is there to be filled
     rather than appearing from nowhere when the take lands. */
  const recording = rec.recorder !== null;
  const incoming = useMemo(
    () =>
      reviewTake(
        blankTake({
          expected: settings.expected || null,
          charWpm: settings.charWpm,
          farnsworthWpm: settings.farnsworthWpm,
          toneHz: loaded.take.toneHz,
        }),
        settings,
      ),
    [settings, loaded.take.toneHz],
  );
  /* A tail of the session rather than all of it, asked for rather than
     imposed: the last one while you are still going, the last few while you
     are checking whether a change is holding. */
  const want = recording ? null : recentCount(settings.showRuns);
  const from = want === null ? 0 : Math.max(stack.length - want, 0);
  const shown = recording ? [incoming] : stack.slice(from);
  /* Clamped into the window rather than left outside it. The effect below
     moves the selection in, and until it has run the chart would be asked to
     caption a row it is not drawing — onto the newest, which is both where
     that effect takes it and what the window is anchored on. */
  const inWindow = !recording && selected >= from;
  const shownAt = inWindow ? selected - from : shown.length - 1;
  /* Where each attempt's row goes, as positions within what is drawn. The
     sort applies to the window rather than choosing it: which attempts you
     are looking at and what order they sit in are two questions, and a Sort
     control that did nothing while a window was in force would be a control
     that lies. */
  const order = useMemo(
    () => runOrder(shown, settings.runSort),
    [shown, settings.runSort],
  );

  /* And the rest of the page reads an attempt the chart is drawing.
     Everything below the chart is about the selected run, so showing a window
     that does not contain it would be two answers to one question. Moving the
     selection rather than teaching each of them a second way to find its
     subject — to the newest, which is the one the window is anchored on. */
  useEffect(() => {
    if (recording || selected >= from || stack.length === 0) return;
    onSelectRun(stack.length - 1);
  }, [recording, from, selected, stack.length, onSelectRun]);
  const [rereading, setRereading] = useState(false);
  /* Seconds left of the lead-in, or null when no cursor is running. Whole
     numbers only: this is state, and updating it every frame would re-render
     the page sixty times a second to redraw the same digit. */
  const [leadLeft, setLeadLeft] = useState<number | null>(null);

  /* Re-reading is DSP over the samples, not a re-grade of the segments, so it
     costs what the pause after a recording costs rather than what a slider
     costs — once per attempt in the session. Said on screen while it
     happens. */
  const chooseProfile = useCallback(
    (id: string | undefined) => {
      setRereading(true);
      void Promise.resolve(onProfileChange(id))
        .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
        .finally(() => setRereading(false));
    },
    [onError, onProfileChange],
  );
  const handle = useRef<ChartHandle>({ chart: null }).current;

  // The playhead moves every frame. Routing it through state would re-render
  // the whole screen sixty times a second; the chart takes it directly.
  const [playhead, setPlayhead] = useState<{ t: number; side: PlaySide } | null>(null);

  const playerRef = useRef<Player | null>(null);
  if (!playerRef.current) {
    playerRef.current = createPlayer({
      onProgress: (t, side) => {
        setPlayhead({ t, side });
        setClock(t);
      },
      onEnded: () => {
        setPlaying(null);
        setPlayhead(null);
        setClock(null);
      },
      onError: setStatus,
    });
  }
  const player = playerRef.current;

  useEffect(() => () => player.destroy(), [player]);

  /* The pacing cursor.
   *
   * A metronome you can watch, running along the TARGET track — the row that
   * shows what the message should look like — while you send another attempt
   * at it. Spacing is the hardest part of sending to feel and the easiest to
   * see, and the chart is already right there showing where every gap ought
   * to fall.
   *
   * Driven straight into the chart rather than through React state. It moves
   * every frame, and routing that through a re-render would repaint the
   * controls, the report and both tables sixty times a second to move one
   * line. The chart owns its playhead for exactly this reason.
   *
   * The clock is the recorder's own — `elapsed()` counts captured samples, so
   * the cursor cannot drift from the recording it is pacing, which a wall
   * clock eventually would. */
  /* While a paced recording runs, the chart is a timeline to follow rather
     than a report to read.
     *
     * The per-character view packs the slots evenly so the columns line up,
     * which is the one thing you do not want under a cursor: the cursor moves
     * in real time and that axis does not, so the two disagree about how far
     * along you are. On the absolute axis a second of silence is a second of
     * chart, and the cursor and the marks mean the same thing. Afterwards the
     * opposite is true — what you want then is the comparison, letter against
     * letter. So it goes out on the way in and comes back on the way out.
     *
     * `onChange` is held in a ref because App rebuilds it on every render: as
     * a dependency it would tear this effect down and run its cleanup between
     * every pair of frames, which is the two views fighting rather than a view
     * being set. */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!rec.recorder || !settings.paceCursor) return;
    onChangeRef.current({ view: "absolute" });
    return () => onChangeRef.current({ view: "per-char" });
  }, [rec.recorder, settings.paceCursor]);

  /** Where the target's first character begins.
   *
   * The count-in is measured backwards from here, not from zero: what the
   * cursor has to arrive at on the beat is the first character, and on an
   * absolute axis that is not necessarily the origin. */
  const paceFrom = useMemo(() => pacedStart(review.ideal), [review.ideal]);

  useEffect(() => {
    const recorder = rec.recorder;
    const chart = handle.chart;
    const lead = settings.paceLeadSec;
    /* Either aid arms the count-in: they are two readings of one schedule, and
       making the card depend on the cursor would have turned two toggles into
       three. Only the cursor touches the chart. */
    const paced = settings.paceCursor || settings.flashCard;
    if (!recorder || !paced || !chart) {
      setLeadLeft(null);
      handle.chart?.setFollow("clamped");
      handle.chart?.setLead(0);
      handle.chart?.setPlayhead(null);
      return;
    }
    /* Room for the count-in, in the chart's own time axis rather than as a
       flourish on top of it. The axis stops at the first character — anything
       earlier clamps to it — so without this the cursor would have nowhere to
       come in from and would simply appear on the beat, which is a count-in
       you cannot count along with. */
    if (settings.paceCursor) {
      chart.setLead(lead);
      /* Locked to the middle while pacing. The card above holds your eye
         there, so the mark you are about to make has to be in the same place
         every time — which means the content moves and the cursor does not,
         from before the first character to after the last. */
      chart.setFollow("centered");
    }

    /* Where the schedule runs out: a moment after the target's last element,
       not after its last character's start. */
    const endsAt = pacedEnd(review.ideal, lead, PACED_STOP_AFTER_SEC);
    let stopped = false;

    let raf = 0;
    let shownLead = -1;
    const tick = () => {
      const into = recorder.elapsed();
      // Reaches the first character exactly as the lead-in runs out.
      if (settings.paceCursor) chart.setPlayhead({ t: paceFrom - lead + into, side: "tgt" });
      const left = into >= lead ? 0 : Math.max(1, Math.ceil(lead - into));
      if (left !== shownLead) {
        shownLead = left;
        setLeadLeft(left);
      }
      /* Stop itself at the end of the message. The take's length was decided
         when the message and the speeds were, so making somebody reach for the
         mouse to say so costs a second of dead air and a hand off the paddle.
         Guarded, because this runs every frame and the recorder takes a moment
         to report that it has closed. */
      if (!stopped && endsAt !== null && into >= endsAt) {
        stopped = true;
        void rec.finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setLeadLeft(null);
      chart.setFollow("clamped");
      chart.setLead(0);
      chart.setPlayhead(null);
    };
    /* `rec` is left out on purpose, and it is the only thing left out.
       `useRecorder` returns a fresh object every render, so listing it would
       tear this loop down and rebuild it on every frame the level meter moves
       — losing the count-in's place and the guard that stops the recorder
       exactly once. What the loop actually needs from it is the recorder
       identity, which IS a dependency, and `finish` at the moment it fires,
       which is stable for a given recorder. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    handle,
    paceFrom,
    rec.recorder,
    review.ideal,
    settings.flashCard,
    settings.paceCursor,
    settings.paceLeadSec,
  ]);

  /* When each character should be keyed, on the recorder's own clock.
   *
   * The cursor reaches the first character exactly as the count-in runs out,
   * so every later one is that moment plus however far into the target it
   * falls. Derived once per message rather than per frame — the schedule does
   * not change while a recording runs. */
  const beats = useMemo(
    () => beatsFor(review.ideal, settings.paceLeadSec),
    [review.ideal, settings.paceLeadSec],
  );

  /* The words behind the preview. Derived from the target rather than from
     `settings.expected`, so the split is the timeline's own — the same gaps
     the chart highlights by, not a second opinion from splitting a string. */
  const words = useMemo(() => wordsFor(review.ideal), [review.ideal]);

  /* Handed as a getter rather than as a number: the card reads the clock on
     its own frames and writes straight to the DOM, so nothing here re-renders
     ten times a second to move one digit. */
  const liveClock = useMemo(() => {
    const recorder = rec.recorder;
    return recorder ? () => recorder.elapsed() : null;
  }, [rec.recorder]);
  useEffect(() => player.setGainDb(settings.gainDb), [player, settings.gainDb]);

  /* The recording as bytes. A file keeps its own, so playback is the file
     rather than a re-encode of our decode of it; a microphone take has none, so
     one is made from the samples at the level they were captured. */
  const audioBytes = useMemo(() => {
    if (loaded.data) return loaded.data;
    const blob = encodeWav(loaded.clip.samples, loaded.clip.rate);
    return blob.arrayBuffer();
  }, [loaded]);

  /* The track the ruler seeks into: the one you were last listening to, or
     the one you picked up by its name in the gutter.
     One ruler runs over both of them, so "play from here" has no answer of
     its own — clicking along a target you are following would otherwise drop
     you back into your own recording every time. */
  const [heard, setHeard] = useState<PlaySide>("you");

  const playYou = useCallback(
    async (from?: number, to?: number) => {
      setHeard("you");
      if (playing === "you" && from === undefined) {
        player.stop();
        return;
      }
      const bytes = await audioBytes;
      setPlaying("you");
      await player.playBuffer(bytes, from, to);
    },
    [audioBytes, player, playing],
  );

  const targetOptions = useMemo(
    () => ({
      peak: Math.min(loaded.take.peak || 0.5, 1),
      padSec: loaded.take.padSec,
      voice: { toneHz: loaded.take.toneHz || 600, filterQ: 3 },
    }),
    [loaded.take],
  );

  const playTarget = useCallback(
    (from?: number, to?: number) => {
      setHeard("tgt");
      if (playing === "tgt" && from === undefined) {
        player.stop();
        return;
      }
      setPlaying("tgt");
      player.playTarget(review.ideal, {
        ...targetOptions,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      });
    },
    [player, playing, review.ideal, targetOptions],
  );

  const stop = useCallback(() => player.stop(), [player]);

  /* Picking up another track ends whatever is playing.
     Everything on this screen that names a recording follows the selection,
     so audio out of the one you just left is the single thing still talking
     about the row you are no longer looking at. */
  const selectRun = useCallback(
    (at: number) => {
      if (at !== selected || heard !== "you") player.stop();
      setHeard("you");
      onSelectRun(at);
    },
    [heard, onSelectRun, player, selected],
  );

  /* The target's name picks up the target and nothing else. It is not an
     attempt — it has no score, no recording and no report — so the row being
     read stays the row being read, and what changes is which track the ruler
     and the transport are about. */
  const selectTarget = useCallback(() => {
    if (heard !== "tgt") player.stop();
    setHeard("tgt");
  }, [heard, player]);

  const playDeviation = useCallback(
    (side: "you" | "tgt", idx: number, kind: Focus["kind"]) => {
      const w = contextWindow(review.slots, side, idx, kind);
      if (!w) return;
      if (side === "you") void playYou(w[0], w[1]);
      else playTarget(w[0], w[1]);
    },
    [playTarget, playYou, review.slots],
  );

  // Keyboard transport. Skipped while a control has focus, or space would
  // toggle the checkbox you just tabbed to instead of starting playback.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      // Space starts playback, and playback during a take would be recorded
      // straight back in through a loopback device. The recorder owns the
      // keyboard while it is running.
      if (rec.recorder) return;
      if (ev.code === "Space") {
        ev.preventDefault();
        if (playing) stop();
        else void playYou(0);
      } else if (ev.key === "t") {
        if (playing === "tgt") stop();
        else playTarget(0);
      } else if (ev.key === "Home") {
        ev.preventDefault();
        handle.chart?.scrollTo(0);
      } else if (ev.key === "End") {
        ev.preventDefault();
        handle.chart?.scrollTo(Number.MAX_SAFE_INTEGER);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handle, playTarget, playYou, playing, rec.recorder, stop]);

  /* Open filling the width. Done once the chart exists and after the first
     layout, because the fit is measured off the real content — a short session
     stranded in a third of the chart is the one thing a timing chart has no use
     for, and empty pixels tell you nothing. */
  const fitted = useRef<string | null>(null);
  /* What the fit is about: the attempts on the chart, not the one being read.
     Keyed on the selected take it re-fitted on every click of a run name —
     each attempt is a slightly different length, so each got a slightly
     different zoom, and picking a row to compare moved every mark on the chart
     including the ones in the rows you were comparing it against.
     The ids rather than the array: the reviews are rebuilt on every settings
     change, and re-fitting on a tolerance slider would undo the zoom you just
     set by hand. */
  const stackId = stack.map((r) => r.take.id).join(" ");
  useEffect(() => {
    // Recording into the session, or starting a new one, still gets the fit a
    // first attempt gets — that changes which takes are on the chart.
    if (fitted.current === stackId || !handle.chart) return;
    fitted.current = stackId;
    const ppu = handle.chart.fit();
    if (ppu !== settings.ppu) onChange({ ppu });
  }, [handle, stackId, onChange, settings.ppu, review]);

  const stem = baseName(loaded.take.source);

  const downloadYou = useCallback(async () => {
    const bytes = await audioBytes;
    saveBlob(new Blob([bytes], { type: "audio/wav" }), `${stem}-yours.wav`);
  }, [audioBytes, stem]);

  const downloadTarget = useCallback(async () => {
    setStatus("rendering target…");
    try {
      const blob = await player.renderTarget(review.ideal, {
        ...targetOptions,
        rate: loaded.take.rate,
      });
      saveBlob(blob, `${stem}-target-${Math.round(settings.charWpm)}wpm.wav`);
      setStatus("");
    } catch (e) {
      setStatus(`target render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [loaded.take.rate, player, review.ideal, settings.charWpm, stem, targetOptions]);

  const downloadPng = useCallback(() => {
    if (!handle.chart) return;
    setStatus("rendering chart…");
    try {
      const out = handle.chart.exportImage();
      out.canvas.toBlob((blob) => {
        if (blob) saveBlob(blob, `${stem}-${settings.view}.png`);
        setStatus(out.note);
      }, "image/png");
    } catch (e) {
      setStatus(`chart render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [handle, settings.view, stem]);

  const downloadJson = useCallback(() => {
    const text = `${JSON.stringify(buildJsonReport(review, settings), null, 2)}\n`;
    saveBlob(new Blob([text], { type: "application/json" }),
      // The speed is in the name because this is a dump of the *current*
      // grading, and re-grading at another speed is a click away — two
      // downloads of one session should not land on the same filename.
      `${stem}-${Math.round(settings.charWpm)}wpm-report.json`);
    setStatus("");
  }, [review, settings, stem]);

  return (
    <>
      {/* The corner, where the way to configuration used to be. Configuration
          is about one thing — the microphone — and now sits beside Calibrate
          where that is decided; this is about the page in front of you, which
          is what the corner of the page should reach. */}
      <ChartSettingsButton open={chartSettings} onToggle={() => setChartSettings((v) => !v)} />
      <header>
        <h1 className="brand">
          {/* The name is the way home. Nothing else on this screen is a
              natural "start over", and a review you cannot leave is a dead
              end — which is exactly what it was. */}
          <button
            className="brandmark"
            onClick={onBack}
            title={`Back to the ${APP_NAME} start screen`}
            // The drawing is decoration; the name is what this control is
            // called, and it has to survive being unreadable at this size.
            aria-label={APP_NAME}
          >
            {/* The same drawing the landing screen showed: the roll is per
                visit, not per mount, so arriving here does not quietly change
                the logo. */}
            <Brandmark art={visitWordmark()} />
          </button>
        </h1>
        <RecordBar
          rec={rec}
          deviceId={deviceId}
          onDeviceChange={onDeviceChange}
          profiles={profiles}
          profileId={profileId}
          onProfileChange={chooseProfile}
          onCalibrate={onCalibrate}
          /* The setup goes behind the settings button, like everything else
             that is not the loop: which microphone, and what to correct it by.
             Both are answered once and then left alone, and both sat in the
             header being rare. */
          configuring={chartSettings}
          appliesToTake={loaded.take.source === MIC_SOURCE}
          rereading={rereading}
          leadLeft={leadLeft}
          onClear={blank ? undefined : onClear}
          onFile={onFile}
          /* A recording carries its own speed, and only the attempt that
             starts a session gets to set one — so a file can begin a session
             but never join one. */
          canOpenFile={blank}
          onNewSession={() => setStarting(true)}
        />
        {/* Last, and on a row of its own: a filename is the one thing here
            whose width nobody controls, and beside the brand it pushed the
            record controls around by however long it happened to be.

            A filename earns the room; "microphone" does not — it is the same
            word every time and is already implied by having just recorded. */}
        {loaded.take.source !== MIC_SOURCE && (
          <p className="src">{loaded.take.source}</p>
        )}
      </header>

      {chartSettings && (
        <section className="chartsettings">
          <ChartSettingsPanel
            settings={settings}
            runs={stack.length}
            onChange={onChange}
          />
        </section>
      )}

      <Controls
        settings={settings}
        onChange={onChange}
        playing={playing}
        clock={clock}
        canPlayYou={!blank}
        onPlayYou={() => void playYou()}
        onPlayTarget={() => playTarget()}
        onStop={stop}
      />

      {/* A band of its own rather than a line of the header. In the header the
          figures were vertically off-center — the row above them sets the
          padding and they got whatever was left — and they are the one thing
          on this screen read at a glance. */}
      <section className="scoresrow">
        <Scores
          review={review}
          settings={settings}
          take={loaded.take}
          onDrop={() => onDropRun(selected)}
          runOf={{ at: selected, of: stack.length }}
        />
      </section>

      {/* A row of their own under the controls, rather than tucked beside the
          legend below the chart. What comes out of this screen is a file, and
          a way out of the app does not belong in the small print of how to
          read the chart. Asked for, though: it is an occasional act, and four
          buttons across the page is a standing invitation to something you do
          rarely. */}
      {settings.showDownloads && (
        <div className="downloads">
          {/* The two that describe a recording are only offered when there is
              one. The target's audio and the chart are both renderable from
              the message and the speeds alone. */}
          <button
            onClick={() => void downloadYou()}
            disabled={blank}
            title="The recording, as made"
          >
            ↓ Your audio
          </button>
          <button
            onClick={() => void downloadTarget()}
            title="Perfect keying of the intended message, rendered at the current speed"
          >
            ↓ Target audio
          </button>
          <button
            onClick={downloadPng}
            title="The whole analysis, not just the visible part"
          >
            ↓ Chart PNG
          </button>
          <button
            onClick={downloadJson}
            disabled={blank}
            title="Every number on this page as JSON, graded at the settings now set — so sessions stack up into a trend"
          >
            ↓ JSON report
          </button>
          <span className="hint">{status}</span>
        </div>
      )}

      {starting && (
        <NewSession
          expected={settings.expected}
          charWpm={settings.charWpm}
          farnsworthWpm={settings.farnsworthWpm}
          onCancel={() => setStarting(false)}
          onStart={(next) => {
            setStarting(false);
            onNewSession(next);
          }}
        />
      )}

      {settings.flashCard && (
        <FlashCard
          beats={beats}
          cue={settings.flashCue}
          leadSec={settings.flashLeadMs / 1000}
          elapsed={liveClock}
          words={settings.wordPreview ? words : EMPTY_WORDS}
        />
      )}

      <section className="canvas-wrap">
        {/* Right above the thing they affect. None of these changes a number
            on the page — they change what is on screen. */}
        <ViewControls
          settings={settings}
          runs={stack.length}
          onChange={onChange}
          onFit={() => {
            const ppu = handle.chart?.fit();
            if (ppu !== undefined) onChange({ ppu });
          }}
        />
        <ChartView
          review={recording ? incoming : review}
          stack={shown}
          order={order}
          selected={shownAt}
          firstRun={recording ? 0 : from}
          onSelectRun={selectRun}
          onSelectTarget={selectTarget}
          onPlayTrack={(side) => {
            if (side === "you") void playYou();
            else playTarget();
          }}
          heard={heard}
          settings={settings}
          focus={focus}
          playhead={playhead}
          handle={handle}
          onPlayChar={(side, from, to) => {
            if (side === "you") void playYou(from, to);
            else playTarget(from, to);
          }}
          onSeek={(at) => {
            const from = Math.max(at[heard] - PLAY_PAD, 0);
            if (heard === "you") void playYou(from);
            else playTarget(from);
          }}
          onZoom={(ppu) => onChange({ ppu })}
        />

        <div className="belowplot">
          {/* The key and the instructions on separate lines. Run together they
              were one paragraph that wrapped wherever the window happened to
              put it, and the last swatch dropped to the next line on its own —
              a key reads as a set, and a set with one member below the others
              reads as two things. */}
          <p className="legend">
            <span className="sw ok" /> within tolerance
            <span className="sw warn" /> up to 2&times; off
            <span className="sw bad" /> worse
            <span className="sw ghost" /> missing
            <span className="sw rest" /> rest (not graded)
          </p>
          {settings.showHints && (
            <>
              <p className="legend howto">
                click a character to hear it, a gap to hear it between what it
                separates &nbsp;·&nbsp; click a track&rsquo;s name to pick it up,
                again to play it &nbsp;·&nbsp; click the ruler to seek
                &nbsp;·&nbsp; scroll to zoom &nbsp;·&nbsp; drag or shift-scroll
                to pan (the view follows playback)
              </p>
              {/* The recording transport, which is otherwise only discoverable
                  by pressing a key and seeing what happens. R carries both
                  halves of one idea — go, from here — so it starts a take and
                  starts a running one over, and the legend says so rather than
                  naming half of what the key does. */}
              <p className="legend keys" data-testid="hotkeys">
                <kbd>R</kbd> record/restart &nbsp;·&nbsp; <kbd>Enter</kbd> finish
                &nbsp;·&nbsp; <kbd>Esc</kbd> cancel
              </p>
            </>
          )}
        </div>
      </section>

      {/* The tables, when they are asked for. With nothing recorded the card
          is not grading at all — it is what to do next — so it stays either
          way; there is nothing yet for a switch about depth to be about. */}
      {(blank || settings.advancedGrading) && (
        <Report
          review={review}
          tolerance={settings.tolerance}
          onPlayDeviation={playDeviation}
          onFocus={setFocus}
        />
      )}
    </>
  );
}
