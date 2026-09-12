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
import { analyzeClip, type AnalyzeOptions } from "@/io/take";
import {
  forgetCurrentTake,
  loadPrefs,
  rememberSettings,
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

export interface AdoptOptions {
  /** Settings to open at, instead of this take's defaults. Used when the take
   *  is coming back out of storage and should look the way it was left. */
  readonly settings?: ReviewSettings | undefined;
  /** Whether to write it to storage. False when it just came from there. */
  readonly remember?: boolean;
}

export interface TakeState {
  loaded: LoadedTake | null;
  settings: ReviewSettings;
  review: Review | null;
  setSettings(patch: Partial<ReviewSettings>): void;
  load(clip: AudioClip, options: AnalyzeOptions, data?: ArrayBuffer | null): void;
  /** Adopt a Take somebody else already analyzed — see io/bundle.ts, and the
   *  restore path in ui/App.tsx. */
  adopt(take: Take, audio: ArrayBuffer, options?: AdoptOptions): void;
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
  return {
    ...base,
    tolerance: p.tolerance ?? base.tolerance,
    gainDb: p.gainDb ?? base.gainDb,
    collapseRests: p.collapseRests ?? base.collapseRests,
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
    view: prev.view,
  };
}

export function useTake(): TakeState {
  const [loaded, setLoaded] = useState<LoadedTake | null>(null);
  const [settings, setSettingsRaw] = useState<ReviewSettings>(() =>
    restorePrefs({
      charWpm: 20,
      farnsworthWpm: 20,
      tolerance: 0.3,
      expected: "",
      collapseRests: true,
      gainDb: 0,
      view: "per-char",
      ppu: 12,
    }),
  );

  /* Read by the callbacks below, which are deliberately stable: a settings
     change must not rebuild `load`, or every consumer of it re-renders on
     every slider frame. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const takeIdRef = useRef<string | null>(null);
  useEffect(() => {
    takeIdRef.current = loaded?.take.id ?? null;
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
      setLoaded({ take, clip: analyzed, data });
      takeIdRef.current = take.id;
      // A new recording resets the speed and the intended message — those
      // belong to it — but keeps the preferences restored above.
      const next = openingSettings(take, settingsRef.current);
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
      setLoaded({
        take,
        clip: { samples: new Float32Array(0), rate: take.rate, peak: take.peak },
        data: audio,
      });
      takeIdRef.current = take.id;
      const next = options.settings ?? openingSettings(take, settingsRef.current);
      setSettingsRaw(next);
      if (options.remember !== false) {
        void rememberTake({ take, audio: new Blob([audio]), settings: next });
      }
    },
    [],
  );

  const clear = useCallback(() => {
    setLoaded(null);
    takeIdRef.current = null;
    // The recording stays in storage — leaving the review is not throwing it
    // away — but a reload should now land on the landing screen, because that
    // is where this click put you.
    forgetCurrentTake();
  }, []);

  const review = useMemo(
    () => (loaded ? reviewTake(loaded.take, settings) : null),
    [loaded, settings],
  );

  return { loaded, settings, review, setSettings, load, adopt, clear };
}
