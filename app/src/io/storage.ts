/* Keeping takes between visits, in the browser.
 *
 * IndexedDB rather than localStorage: a take's segment list runs to a few
 * thousand numbers, localStorage caps out around 5 MB across the whole origin,
 * and it stores strings — so every read and write would be a JSON parse of the
 * entire history.
 *
 * Audio is stored as a Blob in the same record. That is the bulk of it by far,
 * and it is why `list()` reads a lean index rather than whole takes: a history
 * page should not pull sixty megabytes of WAV to show sixty rows.
 *
 * Nothing here leaves the machine. There is no account and no server, which is
 * the other half of why the analysis runs client-side.
 */

import type { ReviewSettings, Take } from "@/types";

const DB_NAME = "cwt";
/** The upgrade is additive and version-agnostic: it creates whichever stores
 *  are missing and touches nothing that is already there, so a database being
 *  made for the first time gets both in one pass.
 *
 *  Only ever raise this. IndexedDB refuses to open an existing database at a
 *  lower version — and the refusal is quiet here, because a failed open is
 *  swallowed by every caller, leaving an app that works perfectly while
 *  saving nothing. */
const DB_VERSION = 2;
const TAKES = "takes";
const CALIBRATIONS = "calibrations";

export interface StoredTake {
  take: Take;
  /** The recording itself, at the level and rate it was made. */
  audio: Blob;
  /** How it was last being looked at. Optional because a take is meaningful
   *  without it — the review re-grades from the segments at whatever settings
   *  are current, and these only restore the ones you had chosen. */
  settings?: ReviewSettings;
}

/** What `list()` returns: enough to render a row, without the audio. */
export interface TakeSummary {
  id: string;
  recordedAt: string;
  source: string;
  durationSec: number;
  decoded: string;
  expected: string | null;
  charWpm: number;
  farnsworthWpm: number;
}

function summarize(take: Take): TakeSummary {
  return {
    id: take.id,
    recordedAt: take.recordedAt,
    source: take.source,
    durationSec: take.durationSec,
    decoded: take.decoded,
    expected: take.expected,
    charWpm: take.measured.charWpm,
    farnsworthWpm: take.measured.farnsworthWpm,
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("this browser has no IndexedDB, so takes cannot be kept"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TAKES)) {
        const store = db.createObjectStore(TAKES, { keyPath: "id" });
        // Sorted by when it was recorded, so the history reads newest-first
        // without loading everything to sort it.
        store.createIndex("recordedAt", "recordedAt");
      }
      if (!db.objectStoreNames.contains(CALIBRATIONS)) {
        const store = db.createObjectStore(CALIBRATIONS, { keyPath: "id" });
        store.createIndex("recordedAt", "recordedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("could not open the database"));
  });
}

function txIn<T>(
  db: IDBDatabase,
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const req = run(t.objectStore(name));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("database request failed"));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return txIn(db, TAKES, mode, run);
}

/** Row as stored. `summary` is duplicated out of `take` so a list can be built
 *  from the index without deserializing the segments. */
interface Row extends TakeSummary {
  id: string;
  take: Take;
  audio: Blob;
  settings?: ReviewSettings;
}

/** How many takes are kept.
 *
 * The audio is the bulk of a row and a long take is tens of megabytes, so this
 * cannot grow without a bound. Ten is enough to cover a practice sitting and
 * leaves room for a history view later without deciding its shape now. */
export const KEEP_TAKES = 10;

export interface TakeStore {
  save(entry: StoredTake): Promise<void>;
  /** Update just the settings on a take already saved, without rewriting its
   *  audio — this runs every time a slider settles. */
  saveSettings(id: string, settings: ReviewSettings): Promise<void>;
  get(id: string): Promise<StoredTake | null>;
  list(): Promise<TakeSummary[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

export async function openTakeStore(): Promise<TakeStore> {
  const db = await openDb();
  return {
    async save({ take, audio, settings }) {
      const row: Row = {
        ...summarize(take),
        id: take.id,
        take,
        audio,
        ...(settings ? { settings } : {}),
      };
      await tx(db, "readwrite", (s) => s.put(row));
      await prune(db);
    },

    async saveSettings(id, settings) {
      const row = await tx<Row | undefined>(db, "readonly", (s) => s.get(id));
      // Gone, because it aged out or the history was cleared. Writing it back
      // from a settings change would resurrect a take with no audio.
      if (!row) return;
      await tx(db, "readwrite", (s) => s.put({ ...row, settings }));
    },

    async get(id) {
      const row = await tx<Row | undefined>(db, "readonly", (s) => s.get(id));
      if (!row) return null;
      return {
        take: row.take,
        audio: row.audio,
        ...(row.settings ? { settings: row.settings } : {}),
      };
    },

    async list() {
      const rows = await tx<Row[]>(db, "readonly", (s) => s.getAll());
      // The summary fields live on the row itself, so this never touches
      // `take` — which is the whole point of duplicating them on save.
      return rows
        .map(({ take: _take, audio: _audio, ...summary }) => summary)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    },

    async remove(id) {
      await tx(db, "readwrite", (s) => s.delete(id));
    },

    async clear() {
      await tx(db, "readwrite", (s) => s.clear());
    },

    close() {
      db.close();
    },
  };
}

/** Drop the oldest rows once there are more than KEEP_TAKES of them.
 *
 * Reads the index rather than the rows, so pruning sixty takes does not pull
 * sixty recordings into memory to decide which to delete. */
async function prune(db: IDBDatabase): Promise<void> {
  const ids = await new Promise<string[]>((resolve, reject) => {
    const t = db.transaction(TAKES, "readonly");
    const req = t.objectStore(TAKES).index("recordedAt").getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error ?? new Error("could not read the index"));
  });
  // getAllKeys on the index comes back oldest-first, which is the order we
  // want to delete in.
  const doomed = ids.slice(0, Math.max(0, ids.length - KEEP_TAKES));
  for (const id of doomed) {
    await tx(db, "readwrite", (s) => s.delete(id));
  }
}

/* ---- calibration recordings ---------------------------------------------- */

/* Every calibration attempt keeps its audio, and the failures are the ones
 * worth having.
 *
 * A calibration that refuses in somebody's room used to leave nothing behind
 * at all: the recording was thrown away the moment the answer appeared, so the
 * one artifact that could explain the answer was the one thing not kept. This
 * is the fix, and it is deliberately not conditional on the attempt having
 * worked — a successful calibration is self-evidently fine, and it is the
 * confusing session that needs a file to send somebody.
 *
 * Forty-odd seconds of mono is a few megabytes, so the count is small and hard.
 */

/** How many attempts to keep. Four is a session's worth of trying. */
export const KEEP_CALIBRATIONS = 4;

export interface StoredCalibration {
  readonly id: string;
  readonly recordedAt: string;
  /** The recording as captured, encoded. */
  readonly audio: Blob;
  readonly durationSec: number;
  /** Speed the drills were keyed at. */
  readonly wpm: number;
  /** What came of it: the problem code, or null when it succeeded. */
  readonly reason: string | null;
  readonly verdict: string;
  /** The offset measured, when one was. */
  readonly offsetSec: number | null;
  /** The profile it was saved as, once it has been. Null while it has not. */
  readonly profileId: string | null;
  readonly deviceLabel: string | null;
}

/** Everything but the audio — enough to render a row without pulling megabytes
 *  off disk for each one. */
export type CalibrationSummary = Omit<StoredCalibration, "audio">;

export async function keepCalibration(entry: StoredCalibration): Promise<void> {
  try {
    const db = await openDb();
    await txIn(db, CALIBRATIONS, "readwrite", (s) => s.put(entry));
    const ids = await txIn<string[]>(db, CALIBRATIONS, "readonly", (s) =>
      s.index("recordedAt").getAllKeys() as IDBRequest<string[]>,
    );
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_CALIBRATIONS))) {
      await txIn(db, CALIBRATIONS, "readwrite", (s) => s.delete(id));
    }
    db.close();
  } catch {
    /* as everywhere else here: forgetting is survivable, failing is not */
  }
}

/** Note which profile an attempt was saved as, once it has been. */
export async function linkCalibration(id: string, profileId: string): Promise<void> {
  try {
    const db = await openDb();
    const row = await txIn<StoredCalibration | undefined>(
      db,
      CALIBRATIONS,
      "readonly",
      (s) => s.get(id),
    );
    if (row) {
      await txIn(db, CALIBRATIONS, "readwrite", (s) => s.put({ ...row, profileId }));
    }
    db.close();
  } catch {
    /* as above */
  }
}

export async function listCalibrations(): Promise<CalibrationSummary[]> {
  try {
    const db = await openDb();
    const rows = await txIn<StoredCalibration[]>(db, CALIBRATIONS, "readonly", (s) =>
      s.getAll(),
    );
    db.close();
    return rows
      .map(({ audio: _audio, ...rest }) => rest)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  } catch {
    return [];
  }
}

export async function getCalibrationAudio(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    const row = await txIn<StoredCalibration | undefined>(
      db,
      CALIBRATIONS,
      "readonly",
      (s) => s.get(id),
    );
    db.close();
    return row?.audio ?? null;
  } catch {
    return null;
  }
}

export async function forgetCalibration(id: string): Promise<void> {
  try {
    const db = await openDb();
    await txIn(db, CALIBRATIONS, "readwrite", (s) => s.delete(id));
    db.close();
  } catch {
    /* as above */
  }
}

/** Drop the recordings belonging to a profile that has been deleted. */
export async function forgetCalibrationsFor(profileId: string): Promise<void> {
  try {
    const db = await openDb();
    const rows = await txIn<StoredCalibration[]>(db, CALIBRATIONS, "readonly", (s) =>
      s.getAll(),
    );
    for (const row of rows.filter((r) => r.profileId === profileId)) {
      await txIn(db, CALIBRATIONS, "readwrite", (s) => s.delete(row.id));
    }
    db.close();
  } catch {
    /* as above */
  }
}

/* ---- settings ----------------------------------------------------------- */

const SETTINGS_KEY = "cwt:prefs";

/** Preferences that should outlive a take, kept small enough for localStorage.
 *
 * Deliberately not the whole ReviewSettings: the speed and the intended message
 * belong to a recording, but which input device you use and how loud you like
 * the playback are about you. */
export interface Prefs {
  deviceId?: string;
  /** The calibration profile being applied, if any — see io/profiles.ts.
   *  Absent means none, which is the default and reads every recording exactly
   *  as it was read before calibration existed. */
  profileId?: string;
  /** The take the review is currently showing, so a reload comes back to it
   *  rather than to an empty landing screen. */
  currentId?: string;
  /** The session the review is showing: several attempts at one message.
   *
   * Only the order and which one was being read. The attempts themselves are
   * already stored as takes, with their audio — a session is a way of reading
   * them, not a second copy of them. Which also means a take outlives the
   * session it was recorded in, and a history view can still find it. */
  session?: { ids: string[]; selected: number };
  /** The speed the keyer is set to, for the calibration wizard. A property of
   *  the equipment rather than of a session, so it outlives both. */
  keyerWpm?: number;
  gainDb?: number;
  tolerance?: number;
  charWpm?: number;
  farnsworthWpm?: number;
  expected?: string;
  view?: string;
  times?: number;
  collapseRests?: boolean;
  paceCursor?: boolean;
  paceLeadSec?: number;
  paceAbsolute?: boolean;
  charMarkers?: boolean;
  runScores?: boolean;
  advancedGrading?: boolean;
  showDownloads?: boolean;
  showHints?: boolean;
  showChartControls?: boolean;
  showRuns?: "all" | "last5" | "last3" | "last";
  captionAll?: boolean;
  flashCard?: boolean;
  wordPreview?: boolean;
  runSort?: string;
}

/* What each preference has to look like coming back off the wire.
 *
 * `Prefs` is a description of what we wrote, not a guarantee about what we will
 * read. Storage is a string keyed by origin: a half-finished write, a hand-edit
 * in devtools, an older build of this app, or — on a GitHub Pages project site,
 * where every project on the account shares one `*.github.io` origin — some
 * other page entirely can all leave something else under this key. Casting that
 * straight to `Prefs` puts whatever it actually is in front of render.
 *
 * Typed as an exhaustive `Record<keyof Prefs, ...>`, so adding a preference
 * without saying how to recognize it fails to compile rather than silently
 * arriving unchecked. */
type Check = (value: unknown) => boolean;

const isStr: Check = (v) => typeof v === "string";
/* Finite, so neither a NaN nor an Infinity smuggled in by a future encoding can
   reach arithmetic and turn a whole screen of figures into NaN. */
const isNum: Check = (v) => typeof v === "number" && Number.isFinite(v);
const isBool: Check = (v) => typeof v === "boolean";
const oneOf =
  (...allowed: readonly string[]): Check =>
  (v) =>
    typeof v === "string" && allowed.includes(v);

/** `{ ids, selected }`, with `selected` an index into `ids` rather than merely
 *  a number — an out-of-range one would read a take that is not there. */
const isSession: Check = (v) => {
  if (typeof v !== "object" || v === null) return false;
  const s = v as { ids?: unknown; selected?: unknown };
  return (
    Array.isArray(s.ids) &&
    s.ids.every(isStr) &&
    typeof s.selected === "number" &&
    Number.isInteger(s.selected) &&
    s.selected >= 0 &&
    s.selected < s.ids.length
  );
};

const PREF_SHAPE: Readonly<Record<keyof Prefs, Check>> = {
  deviceId: isStr,
  profileId: isStr,
  currentId: isStr,
  session: isSession,
  keyerWpm: isNum,
  gainDb: isNum,
  tolerance: isNum,
  charWpm: isNum,
  farnsworthWpm: isNum,
  expected: isStr,
  view: isStr,
  times: isNum,
  collapseRests: isBool,
  paceCursor: isBool,
  paceLeadSec: isNum,
  paceAbsolute: isBool,
  charMarkers: isBool,
  runScores: isBool,
  advancedGrading: isBool,
  showDownloads: isBool,
  showHints: isBool,
  showChartControls: isBool,
  showRuns: oneOf("all", "last5", "last3", "last"),
  captionAll: isBool,
  flashCard: isBool,
  wordPreview: isBool,
  runSort: isStr,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const source = parsed as Record<string, unknown>;

    // Field by field rather than all-or-nothing, the same bargain `loadProfiles`
    // strikes: these preferences are independent of each other, and a corrupt
    // `view` is no reason to also forget which microphone you record on. What
    // fails is dropped, and its caller falls back to that field's own default.
    //
    // Building the result from PREF_SHAPE's keys rather than from the parsed
    // object's is also what keeps a stored key we have never heard of — and any
    // `__proto__`-shaped one — from being copied across at all.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(PREF_SHAPE) as (keyof Prefs)[]) {
      const value = source[key];
      if (value !== undefined && PREF_SHAPE[key](value)) out[key] = value;
    }
    return out as Prefs;
  } catch {
    // A corrupt or blocked store is not worth failing the app over.
    return {};
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode, quota, or storage disabled — all survivable */
  }
}

/* ---- the session you were last looking at -------------------------------- */

/* A reload must not drop a recording you just spent thirty seconds keying. So
 * the current take is kept — audio and all — and the id of it is noted in the
 * preferences, which is the only part that has to be readable synchronously at
 * boot.
 *
 * Every function here swallows its own failures. Storage can be blocked by
 * private browsing, a quota, or a policy, and none of that is a reason to stop
 * the app working for this session: forgetting is a worse experience, not a
 * broken one. */

let opening: Promise<TakeStore> | null = null;

function store(): Promise<TakeStore> {
  if (!opening) {
    // A failed open must not be cached, or one transient error would disable
    // storage for the life of the tab.
    opening = openTakeStore().catch((e: unknown) => {
      opening = null;
      throw e;
    });
  }
  return opening;
}

/** Keep this take, and make it the one a reload comes back to. */
export async function rememberTake(entry: StoredTake): Promise<void> {
  try {
    await (await store()).save(entry);
    // Read the preferences again *after* the write: a settings change may have
    // landed while it was in flight.
    savePrefs({ ...loadPrefs(), currentId: entry.take.id });
  } catch {
    /* nothing kept; the session still works */
  }
}

/** Update the settings on the remembered take. */
export async function rememberSettings(
  id: string,
  settings: ReviewSettings,
): Promise<void> {
  try {
    await (await store()).saveSettings(id, settings);
  } catch {
    /* as above */
  }
}

/** The take the review was last showing, or null to start fresh. */
export async function recallTake(): Promise<StoredTake | null> {
  try {
    const id = loadPrefs().currentId;
    if (!id) return null;
    return await (await store()).get(id);
  } catch {
    return null;
  }
}

/** Remember the session the review is showing. */
export function rememberSession(ids: readonly string[], selected: number): void {
  const next = { ...loadPrefs() };
  if (ids.length) next.session = { ids: [...ids], selected };
  else delete next.session;
  savePrefs(next);
}

/** The attempts the review was last showing, oldest first.
 *
 * Any that have gone missing are skipped rather than failing the lot: a
 * session with three of its four attempts still in it is worth coming back
 * to, and there is nothing a reader could do about the fourth. */
export async function recallSession(): Promise<StoredTake[]> {
  try {
    const s = loadPrefs().session;
    if (!s?.ids?.length) return [];
    const db = await store();
    const out: StoredTake[] = [];
    for (const id of s.ids) {
      const got = await db.get(id);
      if (got) out.push(got);
    }
    return out;
  } catch {
    return [];
  }
}

/** Which attempt of the remembered session was being read. */
export function recallSelected(): number {
  return loadPrefs().session?.selected ?? 0;
}

/** Stop coming back to the current take.
 *
 * The row itself stays — leaving the review is not throwing the recording
 * away, and a history view will want it. */
export function forgetCurrentTake(): void {
  const next = { ...loadPrefs() };
  delete next.currentId;
  delete next.session;
  savePrefs(next);
}
