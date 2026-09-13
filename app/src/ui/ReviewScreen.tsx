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
import { PLAY_PAD } from "@/render/geometry";
import type { Profile } from "@/io/profiles";
import type { Review, ReviewSettings } from "@/types";
import type { AudioClip } from "@/types";
import { ChartView, type ChartHandle } from "./Chart";
import { Controls, ViewControls } from "./Controls";
import { Cog, RecordBar } from "./Record";
import { Report } from "./Report";
import { Scores } from "./Scores";
import { APP_NAME, Brandmark } from "./Wordmark";
import { visitWordmark } from "./wordmarks";
import { MIC_SOURCE } from "@/io/take";
import { baseName } from "./format";
import { useRecorder } from "./useRecorder";
import type { LoadedTake } from "./useTake";

export interface ReviewScreenProps {
  loaded: LoadedTake;
  review: Review;
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
   * calibration the next recording is made under, and the recording on screen
   * is read again through it. */
  profiles: readonly Profile[];
  profileId: string | undefined;
  onProfileChange(id: string | undefined): Promise<void> | void;
  onDeviceChange(id: string | undefined): void;
  onConfigure(): void;
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

export function ReviewScreen({
  loaded,
  review,
  settings,
  onChange,
  onAudio,
  onError,
  deviceId,
  profiles,
  profileId,
  onProfileChange,
  onDeviceChange,
  onConfigure,
  onBack,
}: ReviewScreenProps): React.ReactElement {
  const rec = useRecorder({
    deviceId,
    onClip: useCallback(
      (clip: AudioClip) => onAudio(clip, MIC_SOURCE, true, null),
      [onAudio],
    ),
    onError,
  });

  const [focus, setFocus] = useState<Focus | null>(null);
  const [playing, setPlaying] = useState<PlaySide | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [rereading, setRereading] = useState(false);
  /* Seconds left of the lead-in, or null when no cursor is running. Whole
     numbers only: this is state, and updating it every frame would re-render
     the page sixty times a second to redraw the same digit. */
  const [leadLeft, setLeadLeft] = useState<number | null>(null);

  /* Re-reading is DSP over the samples, not a re-grade of the segments, so it
     costs what the pause after a recording costs rather than what a slider
     costs. Said on screen while it happens. */
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
  /** Where the target's first character begins.
   *
   * The count-in is measured backwards from here, not from zero: what the
   * cursor has to arrive at on the beat is the first character, and on an
   * absolute axis that is not necessarily the origin. */
  const paceFrom = useMemo(() => {
    const first = review.ideal.chars[0];
    if (!first) return 0;
    return first.leadGap ? first.leadGap.t0 : first.t0;
  }, [review.ideal]);

  useEffect(() => {
    const recorder = rec.recorder;
    const chart = handle.chart;
    const lead = settings.paceLeadSec;
    if (!recorder || !settings.paceCursor || !chart) {
      setLeadLeft(null);
      handle.chart?.setLead(0);
      handle.chart?.setPlayhead(null);
      return;
    }
    /* Room for the count-in, in the chart's own time axis rather than as a
       flourish on top of it. The axis stops at the first character — anything
       earlier clamps to it — so without this the cursor would have nowhere to
       come in from and would simply appear on the beat, which is a count-in
       you cannot count along with. */
    chart.setLead(lead);

    let raf = 0;
    let shownLead = -1;
    const tick = () => {
      const into = recorder.elapsed();
      // Reaches the first character exactly as the lead-in runs out.
      chart.setPlayhead({ t: paceFrom - lead + into, side: "tgt" });
      const left = into >= lead ? 0 : Math.max(1, Math.ceil(lead - into));
      if (left !== shownLead) {
        shownLead = left;
        setLeadLeft(left);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setLeadLeft(null);
      chart.setLead(0);
      chart.setPlayhead(null);
    };
  }, [handle, paceFrom, rec.recorder, settings.paceCursor, settings.paceLeadSec]);
  useEffect(() => player.setGainDb(settings.gainDb), [player, settings.gainDb]);

  /* The recording as bytes. A file keeps its own, so playback is the file
     rather than a re-encode of our decode of it; a microphone take has none, so
     one is made from the samples at the level they were captured. */
  const audioBytes = useMemo(() => {
    if (loaded.data) return loaded.data;
    const blob = encodeWav(loaded.clip.samples, loaded.clip.rate);
    return blob.arrayBuffer();
  }, [loaded]);

  const playYou = useCallback(
    async (from?: number, to?: number) => {
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
  const fittedId = useRef<string | null>(null);
  useEffect(() => {
    // Keyed on the take rather than on a bare flag: recording again from this
    // screen swaps the take under the same chart, and a new session deserves
    // the same opening fit a first one gets.
    if (fittedId.current === loaded.take.id || !handle.chart) return;
    fittedId.current = loaded.take.id;
    const ppu = handle.chart.fit();
    if (ppu !== settings.ppu) onChange({ ppu });
  }, [handle, loaded.take.id, onChange, settings.ppu, review]);

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
      <Cog onClick={onConfigure} />
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
          appliesToTake={loaded.take.source === MIC_SOURCE}
          rereading={rereading}
          leadLeft={leadLeft}
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

      {/* A band of its own rather than a line of the header. In the header the
          figures were vertically off-centre — the row above them sets the
          padding and they got whatever was left — and they are the one thing
          on this screen read at a glance. */}
      <section className="scoresrow">
        <Scores review={review} settings={settings} take={loaded.take} />
      </section>

      <Controls
        settings={settings}
        onChange={onChange}
        hasExpected={!!loaded.take.expected}
        playing={playing}
        clock={clock}
        onPlayYou={() => void playYou()}
        onPlayTarget={() => playTarget()}
        onStop={stop}
      />

      <section className="canvas-wrap">
        {/* Right above the thing they affect. None of these changes a number
            on the page — they change what is on screen. */}
        <ViewControls
          settings={settings}
          onChange={onChange}
          onFit={() => {
            const ppu = handle.chart?.fit();
            if (ppu !== undefined) onChange({ ppu });
          }}
        />
        <ChartView
          review={review}
          settings={settings}
          focus={focus}
          playhead={playhead}
          handle={handle}
          onPlayChar={(side, from, to) => {
            if (side === "you") void playYou(from, to);
            else playTarget(from, to);
          }}
          onSeek={(t) => void playYou(Math.max(t - PLAY_PAD, 0))}
          onZoom={(ppu) => onChange({ ppu })}
        />

        <div className="belowplot">
          <p className="legend">
            <span className="sw ok" /> within tolerance
            <span className="sw warn" /> up to 2&times; off
            <span className="sw bad" /> worse
            <span className="sw ghost" /> missing
            <span className="sw rest" /> rest (not graded)
            &nbsp;·&nbsp; click a character to hear it, a gap to hear it between
            what it separates &nbsp;·&nbsp; click the ruler to seek
            &nbsp;·&nbsp; scroll to zoom &nbsp;·&nbsp; drag or shift-scroll to pan
            (the view follows playback)
          </p>
          <div className="downloads">
            <button onClick={() => void downloadYou()} title="The recording, as made">
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
              title="Every number on this page as JSON, graded at the settings now set — so sessions stack up into a trend"
            >
              ↓ JSON report
            </button>
            <span className="hint">{status}</span>
          </div>
        </div>
      </section>

      <Report
        review={review}
        tolerance={settings.tolerance}
        onPlayDeviation={playDeviation}
        onFocus={setFocus}
      />
    </>
  );
}
