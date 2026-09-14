/* The one piece of app-level state: which recording is loaded, and how it is
 * being looked at.
 *
 * Kept in a hook rather than in a store because there is exactly one of it and
 * it never needs to be read from two places at once. The review itself is
 * derived — `reviewTake` is pure and fast enough to run on every settings
 * change, so nothing here caches a graded result that could go stale.
 *
 * It is also the place that remembers. Whatever is loaded gets written to
 * IndexedDB along with the settings it is being viewed at, so a reload comes
 * back to it; see io/storage.ts for why that never fails loudly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeWav } from "@/audio/wav";
import { decodeAudioFile } from "@/dsp";
import { FLASH_LEAD_DEFAULT_MS, PACE_LEAD_DEFAULT_SEC } from "@/render/geometry";
import {
  MIC_SOURCE,
  analyzeClip,
  blankTake,
  isBlankTake,
  type AnalyzeOptions,
} from "@/io/take";
import { profileForSource, type Profile } from "@/io/profiles";
import {
  forgetCurrentTake,
  loadPrefs,
  rememberSettings,
  rememberSession,
  rememberTake,
  savePrefs,
} from "@/io/storage";
import { defaultSettings, reviewTake } from "@/timing";
import type { AudioClip, Review, ReviewSettings, Take } from "@/types";

export interface LoadedTake {
  take: Take;
  /** The audio as recorded, for playback and for the download. */
  clip: AudioClip;
  /** The original file bytes, when the audio came from a file — so playback is
   *  the file itself rather than a re-encode of our decode of it. */
  data: ArrayBuffer | null;
}

/** One attempt as it comes back out of storage. */
export interface StoredRun {
  take: Take;
  audio: ArrayBuffer;
  settings?: ReviewSettings | undefined;
}

export interface AdoptOptions {
  /** Settings to open at, instead of this take's defaults. Used when the take
   *  is coming back out of storage and should look the way it was left. */
  readonly settings?: ReviewSettings | undefined;
  /** Whether to write it to storage. False when it just came from there. */
  readonly remember?: boolean;
}

export interface TakeState {
  loaded: LoadedTake | null;
  /** Every attempt in this session, oldest first. */
  runs: readonly LoadedTake[];
  /** Which of them is being read in detail. */
  selected: number;
  /** Restore a whole session from storage — see `recallSession`. */
  adoptSession(entries: readonly StoredRun[], selected: number): void;
  /** One review per run, all against the same target. */
  reviews: readonly Review[];
  selectRun(i: number): void;
  /** Throw away one attempt and keep the rest — a sneeze, a dropped paddle.
   *
   * Distinct from `reset`, which wipes the whole session. A bad run is the
   * common case and wants one click; starting over is the rarer one. */
  dropRun(i: number): void;
  settings: ReviewSettings;
  review: Review | null;
  setSettings(patch: Partial<ReviewSettings>): void;
  load(clip: AudioClip, options: AnalyzeOptions, data?: ArrayBuffer | null): void;
  /** Adopt a Take somebody else already analyzed — see io/bundle.ts, and the
   *  restore path in ui/App.tsx. */
  adopt(take: Take, audio: ArrayBuffer, options?: AdoptOptions): void;
  /** Read the loaded recording again under a different calibration.
   *
   * The same computation that ran when it was recorded, on the same audio,
   * with one input changed — so it is a re-analysis and not a re-grading.
   * Everything downstream of the segments already re-grades on every settings
   * change; this is the one input that lives upstream of them.
   *
   * It is also the most useful measuring tool in the app. Recording the same
   * message twice to compare calibrations leaves the room, the placement and
   * the operator's fist free to vary; switching the profile under one
   * recording holds all three fixed by construction. */
  recalibrate(profile: Profile | null): Promise<void>;
  /** Practice at whatever speed the keyer was last said to be set to.
   *
   * Called on the way back from the calibration wizard, which is where that
   * speed gets stated. A recording already on screen keeps its own — the speed
   * there is what the take is graded against and changing it would re-grade
   * somebody's work behind their back — so this only moves a session that has
   * nothing recorded in it yet. */
  adoptKeyerSpeed(): void;
  /** Throw the recording away and stay here, ready to make another.
   *
   * Not the same as `clear`, which leaves the review entirely. This keeps the
   * session — the message you are practicing, the speeds, the pacing cursor —
   * and drops only what was recorded into it, which is the loop: set it up,
   * hear the target, send it, look at it, wipe it, send it again. */
  reset(overrides?: Partial<ReviewSettings>): void;
  clear(): void;
}

/** Settings worth remembering between recordings.
 *
 * The speed and the intended message belong to a take; the tolerance, the
 * listening level and which view you prefer are about you, and having to set
 * them again after every recording would be the most annoying thing about the
 * app. */
function restorePrefs(base: ReviewSettings): ReviewSettings {
  const p = loadPrefs();
  /* The keyer's own speed, when it has been stated. Calibration asks for it
     because the measurement needs it, but it is a fact about the equipment
     rather than about that one wizard — so having told the app the paddle is
     set to 25, being handed a review that assumes 20 is the app forgetting
     something it was told. Both speeds, or naming the character speed alone
     would introduce a Farnsworth gap nobody asked for. */
  const keyer = p.keyerWpm && p.keyerWpm > 0 ? p.keyerWpm : null;
  return {
    ...base,
    ...(keyer ? { charWpm: keyer, farnsworthWpm: keyer } : {}),
    tolerance: p.tolerance ?? base.tolerance,
    gainDb: p.gainDb ?? base.gainDb,
    collapseRests: p.collapseRests ?? base.collapseRests,
    paceCursor: p.paceCursor ?? base.paceCursor,
    paceLeadSec: p.paceLeadSec ?? base.paceLeadSec,
    charMarkers: p.charMarkers ?? base.charMarkers,
    flashCard: p.flashCard ?? base.flashCard,
    flashCue: p.flashCue ?? base.flashCue,
    flashLeadMs: p.flashLeadMs ?? base.flashLeadMs,
    wordPreview: p.wordPreview ?? base.wordPreview,
    view: (p.view as ReviewSettings["view"]) ?? base.view,
  };
}

/** The settings a freshly loaded take should open at: its own defaults, but
 *  keeping the preferences that belong to the person rather than the take. */
function openingSettings(take: Take, prev: ReviewSettings): ReviewSettings {
  return {
    ...defaultSettings(take),
    tolerance: prev.tolerance,
    gainDb: prev.gainDb,
    collapseRests: prev.collapseRests,
    paceCursor: prev.paceCursor,
    paceLeadSec: prev.paceLeadSec,
    charMarkers: prev.charMarkers,
    flashCard: prev.flashCard,
    flashCue: prev.flashCue,
    flashLeadMs: prev.flashLeadMs,
    wordPreview: prev.wordPreview,
    view: prev.view,
  };
}

export function useTake(): TakeState {
  /* A session is several attempts at one message, so what is held is a list.
   * `loaded` is whichever of them is being read in detail — everything below
   * the chart is about one attempt, and the list is what the chart draws. */
  const [runs, setRuns] = useState<LoadedTake[]>([]);
  const [selected, setSelected] = useState(0);
  const loaded = runs[selected] ?? runs[runs.length - 1] ?? null;
  const [settings, setSettingsRaw] = useState<ReviewSettings>(() =>
    restorePrefs({
      charWpm: 20,
      farnsworthWpm: 20,
      tolerance: 0.3,
      expected: "",
      collapseRests: true,
      paceCursor: false,
      paceLeadSec: PACE_LEAD_DEFAULT_SEC,
      charMarkers: false,
      flashCard: false,
      flashCue: true,
      flashLeadMs: FLASH_LEAD_DEFAULT_MS,
      wordPreview: false,
      gainDb: 0,
      view: "per-char",
      ppu: 12,
    }),
  );

  const runsRef = useRef(runs);
  runsRef.current = runs;

  /* Written from one place rather than from each of load, drop, select, reset
     and recalibrate. Those are five chances to forget, and forgetting shows up
     as a reload quietly losing an attempt — which looks like the recording
     failed rather than like the bookkeeping did. */
  useEffect(() => {
    const ids = runs.filter((r) => !isBlankTake(r.take)).map((r) => r.take.id);
    /* Only ever written, never cleared from here. On the first render there is
       nothing loaded yet — and this effect runs before the one that restores a
       session, so clearing on an empty list would wipe the thing we are about
       to come back to, every single reload. Forgetting a session is Clear's
       job, and it says so explicitly. */
    if (ids.length === 0) return;
    rememberSession(ids, Math.min(selected, ids.length - 1));
  }, [runs, selected]);

  /** Start a session over with one attempt in it. */
  const showOnly = useCallback((entry: LoadedTake) => {
    setRuns([entry]);
    setSelected(0);
    runsRef.current = [entry];
  }, []);

  /* Read by the callbacks below, which are deliberately stable: a settings
     change must not rebuild `load`, or every consumer of it re-renders on
     every slider frame. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const takeIdRef = useRef<string | null>(null);
  const loadedRef = useRef<LoadedTake | null>(null);
  useEffect(() => {
    takeIdRef.current = loaded?.take.id ?? null;
    loadedRef.current = loaded;
  }, [loaded]);

  // Persisting on every slider frame would write to localStorage sixty times a
  // second; the trailing edge is the only one that matters.
  const persistTimer = useRef<number | null>(null);
  const persist = useCallback((next: ReviewSettings) => {
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      savePrefs({
        ...loadPrefs(),
        tolerance: next.tolerance,
        gainDb: next.gainDb,
        collapseRests: next.collapseRests,
        paceCursor: next.paceCursor,
        paceLeadSec: next.paceLeadSec,
        charMarkers: next.charMarkers,
        flashCard: next.flashCard,
        flashCue: next.flashCue,
        flashLeadMs: next.flashLeadMs,
        wordPreview: next.wordPreview,
        view: next.view,
      });
      // The rest of the settings belong to the take, so they ride along with
      // it rather than becoming preferences for every future recording.
      const id = takeIdRef.current;
      if (id) void rememberSettings(id, next);
    }, 400);
  }, []);

  const setSettings = useCallback(
    (patch: Partial<ReviewSettings>) => {
      setSettingsRaw((prev) => {
        const next = { ...prev, ...patch };
        // Overall speed can never exceed character speed; dragging one drags
        // the other rather than letting the pair go invalid.
        if (next.farnsworthWpm > next.charWpm) next.farnsworthWpm = next.charWpm;
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const load = useCallback(
    (clip: AudioClip, options: AnalyzeOptions, data: ArrayBuffer | null = null) => {
      const { take, clip: analyzed } = analyzeClip(clip, options);
      const entry: LoadedTake = { take, clip: analyzed, data };
      /* The first attempt establishes what the session is about; later ones
         join it. So only the first sets the speed and the intended message —
         letting run 2 do that would replace the target halfway through a
         session with whatever that run happened to be recorded against, and
         re-grade everything already on screen. */
      const first = runsRef.current.filter((r) => !isBlankTake(r.take)).length === 0;
      const next = first ? openingSettings(take, settingsRef.current) : settingsRef.current;

      const stacked = first ? [entry] : [...runsRef.current, entry];
      setRuns(stacked);
      runsRef.current = stacked;
      setSelected(stacked.length - 1);
      loadedRef.current = entry;
      takeIdRef.current = take.id;
      setSettingsRaw(next);

      /* A file keeps its own bytes; a microphone take has none until they are
         encoded, and storing one means encoding it now rather than at download
         time. Trimmed, because `analyzed` is what every time in the take is
         measured against — storing the untrimmed original would shift the
         whole chart by the lead on reload. */
      const audio = data
        ? new Blob([data])
        : encodeWav(analyzed.samples, analyzed.rate);
      void rememberTake({ take, audio, settings: next });
    },
    [],
  );

  const adopt = useCallback(
    (take: Take, audio: ArrayBuffer, options: AdoptOptions = {}) => {
      // No DSP here: the segments arrived already measured. Everything from the
      // grading onward is the same code path a browser recording takes, which is
      // the point of shipping the take raw rather than pre-graded.
      const entry: LoadedTake = {
        take,
        clip: { samples: new Float32Array(0), rate: take.rate, peak: take.peak },
        data: audio,
      };
      showOnly(entry);
      loadedRef.current = entry;
      takeIdRef.current = take.id;
      const next = options.settings ?? openingSettings(take, settingsRef.current);
      setSettingsRaw(next);
      if (options.remember !== false) {
        void rememberTake({ take, audio: new Blob([audio]), settings: next });
      }
    },
    [],
  );

  const recalibrate = useCallback(async (profile: Profile | null) => {
    const current = loadedRef.current;
    if (!current) return;
    const take = current.take;
    /* A file is never corrected, wherever the request came from. It was made
       somewhere else — possibly by somebody else, possibly through a loopback
       with nothing in the path at all — and applying this machine's
       calibration to it would quietly alter numbers that were already
       measured. */
    const applied = profileForSource(profile, take.source === MIC_SOURCE);

    /* Coming back from a reload there are no samples in memory, only the wav
       that was stored. It decodes to the same audio the take was measured
       from, because what gets stored is the trimmed clip. */
    const clip: AudioClip = current.clip.samples.length
      ? current.clip
      : await decodeAudioFile(current.data!.slice(0));

    const { take: next } = analyzeClip(clip, {
      source: take.source,
      expected: take.expected,
      expectedSource: take.expectedSource,
      // Not re-detected: the tone did not change, and letting it wander would
      // make this a different measurement rather than the same one under a
      // different calibration.
      toneHz: take.toneHz,
      ...(take.target.explicit
        ? { targetWpm: take.target.charWpm, targetFarnsworth: take.target.farnsworthWpm }
        : {}),
      // Already trimmed when it was first analyzed; trimming again would move
      // every time in the take by whatever it found.
      trim: false,
      now: take.recordedAt,
      id: take.id,
      profile: applied,
    });

    // Same recording, same identity — not a new entry in the history each
    // time somebody tries a different profile.
    const reread: LoadedTake = { take: next, clip: current.clip, data: current.data };
    setRuns((prev) => {
      const out = prev.map((r) => (r.take.id === take.id ? reread : r));
      runsRef.current = out;
      return out;
    });
    /* And the same settings. Zoom, tolerance, speeds and intended text belong
       to the person looking, not to the analysis, and resetting them here
       would punish exactly the comparison this exists for. */
    const kept = settingsRef.current;
    const audio = current.data
      ? new Blob([current.data])
      : encodeWav(clip.samples, clip.rate);
    void rememberTake({ take: next, audio, settings: kept });
  }, []);

  const adoptSession = useCallback(
    (entries: readonly StoredRun[], at: number) => {
      if (entries.length === 0) return;
      const lanes: LoadedTake[] = entries.map((e) => ({
        take: e.take,
        clip: { samples: new Float32Array(0), rate: e.take.rate, peak: e.take.peak },
        data: e.audio,
      }));
      const pick = Math.min(Math.max(at, 0), lanes.length - 1);
      setRuns(lanes);
      runsRef.current = lanes;
      setSelected(pick);
      loadedRef.current = lanes[pick]!;
      takeIdRef.current = lanes[pick]!.take.id;

      /* Settings belong to the session rather than to any one attempt, so the
         one being read carries them — and failing that, the last recorded.
         Rebuilding them from a take would drop the intended message, which is
         the one thing every attempt in the session shares. */
      const kept = entries[pick]?.settings ?? entries[entries.length - 1]?.settings;
      const next = kept ?? openingSettings(lanes[pick]!.take, settingsRef.current);
      settingsRef.current = next;
      setSettingsRaw(next);
    },
    [],
  );

  const adoptKeyerSpeed = useCallback(() => {
    const keyer = loadPrefs().keyerWpm;
    if (!keyer || !(keyer > 0)) return;
    const take = loadedRef.current?.take;
    if (take && !isBlankTake(take)) return;
    setSettings({ charWpm: keyer, farnsworthWpm: keyer });
  }, [setSettings]);

  const reset = useCallback((overrides: Partial<ReviewSettings> = {}) => {
    /* Overrides, because this is reached from two places that know different
       things. From the review it keeps the session exactly as it is; from the
       landing screen there is no session yet and the message being practiced
       lives up in the app, not in settings that have never been used. */
    const s = { ...settingsRef.current, ...overrides };
    if (s.farnsworthWpm > s.charWpm) s.farnsworthWpm = s.charWpm;
    const take = blankTake({
      expected: s.expected || null,
      expectedSource: s.expected ? "what you said you'd send" : null,
      charWpm: s.charWpm,
      farnsworthWpm: s.farnsworthWpm,
      ...(loadedRef.current ? { toneHz: loadedRef.current.take.toneHz } : {}),
    });
    const entry: LoadedTake = {
      take,
      clip: { samples: new Float32Array(0), rate: take.rate, peak: 0 },
      data: null,
    };
    showOnly(entry);
    loadedRef.current = entry;
    takeIdRef.current = null;
    settingsRef.current = s;
    setSettingsRaw(s);
    /* Deliberately not remembered. There is nothing in it to come back to, and
       a reload should land on the landing screen rather than on an empty
       review somebody has to work out how to leave. */
    forgetCurrentTake();
  }, []);

  const clear = useCallback(() => {
    setRuns([]);
    setSelected(0);
    runsRef.current = [];
    takeIdRef.current = null;
    // The recording stays in storage — leaving the review is not throwing it
    // away — but a reload should now land on the landing screen, because that
    // is where this click put you.
    forgetCurrentTake();
  }, []);

  /* Every attempt, graded against the same target at the same settings.
   *
   * One review each rather than one review of several takes: a Review pairs
   * one decode against one target, and that is exactly what a run is. What
   * they share is the target, which comes out of the settings — so changing a
   * speed or fixing a typo in the message re-grades the whole session at once,
   * which is what keeps the rows comparable. */
  const reviews = useMemo(
    () => runs.map((r) => reviewTake(r.take, settings)),
    [runs, settings],
  );
  const review = reviews[selected] ?? reviews[reviews.length - 1] ?? null;

  const selectRun = useCallback((i: number) => {
    setSelected((prev) => (i >= 0 && i < runsRef.current.length ? i : prev));
  }, []);

  const dropRun = useCallback((i: number) => {
    const rest = runsRef.current.filter((_, k) => k !== i);
    runsRef.current = rest;
    setRuns(rest);
    // Land on the attempt that took its place, or the last one if it was.
    setSelected((prev) => Math.max(0, Math.min(prev > i ? prev - 1 : prev, rest.length - 1)));
  }, []);

  return {
    loaded,
    adoptSession,
    runs,
    selected,
    reviews,
    selectRun,
    dropRun,
    settings,
    review,
    setSettings,
    load,
    adopt,
    recalibrate,
    adoptKeyerSpeed,
    reset,
    clear,
  };
}
