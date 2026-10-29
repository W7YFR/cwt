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
 *  made for the first time gets all of them in one pass.
 *
 *  Only ever raise this. IndexedDB refuses to open an existing database at a
 *  lower version — and the refusal is quiet here, because a failed open is
 *  swallowed by every caller, leaving an app that works perfectly while
 *  saving nothing. */
const DB_VERSION = 4;
const TAKES = "takes";
const CALIBRATIONS = "calibrations";
const QSO_OVERS = "qsoOvers";
const COPY_FILE = "copyFile";

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
      if (!db.objectStoreNames.contains(QSO_OVERS)) {
        db.createObjectStore(QSO_OVERS, { keyPath: "line" });
      }
      if (!db.objectStoreNames.contains(COPY_FILE)) {
        db.createObjectStore(COPY_FILE, { keyPath: "id" });
      }
    };
    /* Another tab holds the database open at an older version. The open
       waits until that tab lets go, so say why the page is waiting. */
    req.onblocked = () => setUpgradeBlocked(true);
    req.onsuccess = () => {
      setUpgradeBlocked(false);
      const db = req.result;
      /* A newer version in another tab wants to upgrade. Let go, or that tab
         waits for this one to close. */
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      setUpgradeBlocked(false);
      reject(req.error ?? new Error("could not open the database"));
    };
  });
}

/* Whether an open waits on another tab, for the page to show. */
let upgradeBlocked = false;
const blockedListeners = new Set<(blocked: boolean) => void>();

function setUpgradeBlocked(blocked: boolean): void {
  if (blocked === upgradeBlocked) return;
  upgradeBlocked = blocked;
  for (const listener of blockedListeners) listener(blocked);
}

/** Call `listener` when an open starts or stops waiting on another tab.
 *  Returns the call that stops listening. */
export function watchUpgradeBlocked(listener: (blocked: boolean) => void): () => void {
  blockedListeners.add(listener);
  listener(upgradeBlocked);
  return () => {
    blockedListeners.delete(listener);
  };
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
  /** Call `run` when the connection closes for another tab's upgrade. */
  onClose(run: () => void): void;
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

    onClose(run) {
      db.onversionchange = () => {
        db.close();
        run();
      };
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
  /** The practice screen was open with nothing recorded in it, so a reload
   *  opens it again rather than the landing screen. A session, when there is
   *  one, comes back instead. */
  practicing?: boolean;
  /** The newest landing screen this visitor has passed through — see
   *  LANDING_VERSION in ui/Landing.tsx. */
  landingSeen?: number;
  /** The settings panel was open, so a reload opens it again. */
  settingsOpen?: boolean;
  /** Which half of Configuration was on show. */
  configTab?: string;
  /** Calibration's speed, from saves that hold no `charWpm`. Read by
   *  `loadSpeed` as a fallback and never written. */
  keyerWpm?: number;
  gainDb?: number;
  tolerance?: number;
  /** The practice speed, shared by every screen. Read through `loadSpeed`. */
  charWpm?: number;
  farnsworthWpm?: number;
  expected?: string;
  view?: string;
  /** The chart's zoom, so a reload of a screen with nothing recorded in it
   *  keeps it. A session keeps its own, with its takes. */
  ppu?: number;
  times?: number;
  collapseRests?: boolean;
  paceCursor?: boolean;
  paceLeadSec?: number;
  breakSec?: number;
  paceAbsolute?: boolean;
  charMarkers?: boolean;
  runScores?: boolean;
  advancedGrading?: boolean;
  ignoreConstruction?: boolean;
  showDownloads?: boolean;
  showHints?: boolean;
  showChartControls?: boolean;
  showRuns?: "all" | "last5" | "last3" | "last";
  captionAll?: boolean;
  zenMode?: boolean;
  plainFollow?: boolean;
  plainGrading?: boolean;
  zenProgress?: boolean;
  zenGrading?: boolean;
  runSort?: string;
  /** Who is sending, for drills that key your own details. */
  user?: Partial<UserInfo>;
  /** Drills the user wrote, in the order they were saved. */
  customDrills?: CustomDrill[];
  /** Which page is open: practice (Send), Copy or QSO. Absent is practice. */
  page?: "practice" | "copy" | "qso";
  /** How the QSO page reads your sending. Absent is lenient. */
  qsoCopy?: "strict" | "lenient";
  /** How much the QSO page's station says in each over. Absent is full. */
  qsoLength?: "full" | "short" | "pieces" | "mixed";
  /** How the station's overs show on the QSO page. Absent is whole. */
  qsoTheirText?: "before" | "sent" | "hidden" | "copy" | "none";
  /** Copy mode: you type the station's lines in a box or in slots. Absent
   *  is a box. */
  qsoCopyInput?: "text" | "slots";
  /** The kind of QSO the QSO page's guide shows. */
  qsoGuide?: "cq" | "cwt" | "sst" | "mst" | "pota";
  /** The QSO page shows the examples beside the log, on a wide screen. */
  qsoSideGuide?: boolean;
  /** Blurred station text blurs the station's call in the log too. Absent
   *  is off. */
  qsoBlurCall?: boolean;
  /** Continue on the QSO page plays the station's last over again. Absent
   *  is on. */
  qsoReplay?: boolean;
  /** How your own overs show on the QSO page. Absent is as sent. */
  qsoYourText?: "sent" | "hidden" | "none";
  /** When the QSO page suggests your next reply. */
  qsoHints?: "off" | "always" | "copied";
  /** The QSO page grades each slot as you type it. */
  qsoGradeTyping?: boolean;
  /** A locked copy on the QSO page can be opened again with Edit. */
  qsoAllowEdits?: boolean;
  /** When the QSO page's play buttons show. Absent is always. */
  qsoPlayback?: "never" | "always" | "end";
  /** Download shows under a QSO that is over. Absent is on. */
  qsoShowDownload?: boolean;
  /** The QSO page's settings band was open. */
  qsoSettingsOpen?: boolean;
  /** Copy mode: your copy locks when you start sending. Absent is on. */
  qsoLockCopy?: boolean;
  /** Copy mode: what a locked copy shows before the QSO ends: your copy, your
   *  copy marked right and wrong, or the graded result. Absent is your copy. */
  qsoLockedShows?: "nothing" | "grade" | "right";
  /** Your lines show the speed you sent them at. Absent is off. */
  qsoShowSpeed?: boolean;
  /** The station's lines show the speed it sent them at. Absent is off. */
  qsoShowTheirSpeed?: boolean;
  /** The Copy page's settings band was open. */
  copySettingsOpen?: boolean;
  /** How you copy on the Copy page: in a box, or a slot per character.
   *  Absent is a box. */
  copyInput?: "text" | "slots";
  /** What shows of a line on the Copy page as it plays. Absent is a box to
   *  copy in. */
  copyLines?: "copy" | "sent" | "before";
  /** A line's copy locks a few seconds after the line ends. Absent is on. */
  copyLock?: boolean;
  /** What a locked copy shows on the Copy page. Absent is what you got
   *  right. */
  copyLockedShows?: "nothing" | "grade" | "right";
  /** A station's call stays hidden until you copy it. Absent is on. */
  copyHideCalls?: boolean;
  /** In slots on the Copy page, the slot playing lights up. Absent is off. */
  copyFollow?: boolean;
  /** In slots on the Copy page, each filled slot is graded as you type.
   *  Absent is off. */
  copyGradeTyping?: boolean;
  /** On the Copy page, while paused, selecting a slot moves the recording to
   *  its character. Absent is off. */
  copySeekSlot?: boolean;
  /** Which earlier attempts show while you try again on the Copy page: all,
   *  the last, or none, to go again clean. Absent is the last. */
  copyEarlier?: "all" | "last" | "none";
  /** The kind of QSO New exchange generates on the Copy page. Absent is CQ. */
  copyKind?: "cq" | "cwt" | "sst" | "mst" | "pota";
  /** How many QSOs a generated run has. Absent is 3. */
  copyRunQsos?: number;
  /** How much each station says in a generated rag chew. Absent is full. */
  copyChatLength?: "full" | "short" | "pieces";
  /** Between two lines of a generated QSO: a silence of so many seconds, or
   *  wait, which stops at the end of each line until Enter. Absent is 1. */
  copyGap?: "1" | "2" | "3" | "5" | "wait";
  /** A generated QSO's stations send at the speeds of its format, or all at
   *  the Copy page's sliders. Absent is the format's. */
  copySpeed?: "format" | "mine";
  /** The Copy page's sliders, for a generated QSO. */
  copyCharWpm?: number;
  copyFarnsworthWpm?: number;
}

/** A drill the user wrote. The text is stored as `normalizeDrill` leaves it,
 *  slots and all. */
export interface CustomDrill {
  id: string;
  text: string;
}

export interface UserInfo {
  name: string;
  callsign: string;
  age: string;
  yearLicensed: string;
  /** Your CWops member number, for the CWT. Empty if you are not a member. */
  cwopsNumber: string;
  qthCity: string;
  /** State, province or country, abbreviated: "OR". */
  qthRegionShort: string;
  /** The same, spelled out: "OREGON". */
  qthRegionLong: string;
  antenna: string;
  rigManufacturer: string;
  rigModel: string;
  /** Transmit power, in watts. */
  rigPower: string;
}

export const EMPTY_USER: UserInfo = {
  name: "",
  callsign: "",
  age: "",
  yearLicensed: "",
  cwopsNumber: "",
  qthCity: "",
  qthRegionShort: "",
  qthRegionLong: "",
  antenna: "",
  rigManufacturer: "",
  rigModel: "",
  rigPower: "",
};

export function loadUser(): UserInfo {
  const saved = loadPrefs().user;
  const out = { ...EMPTY_USER };
  if (saved) for (const k of Object.keys(EMPTY_USER) as (keyof UserInfo)[]) out[k] = (saved[k] ?? "").toUpperCase();
  return out;
}

export function saveUser(user: UserInfo): void {
  savePrefs({ ...loadPrefs(), user });
}

export function loadCustomDrills(): CustomDrill[] {
  return loadPrefs().customDrills ?? [];
}

export function saveCustomDrills(customDrills: CustomDrill[]): void {
  savePrefs({ ...loadPrefs(), customDrills });
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

/** Each known field absent or a string. Absent, so a field added later does
 *  not throw away the ones already saved. */
const isUser: Check = (v) => {
  if (typeof v !== "object" || v === null) return false;
  const u = v as Record<string, unknown>;
  return (Object.keys(EMPTY_USER) as (keyof UserInfo)[]).every(
    (k) => u[k] === undefined || isStr(u[k]),
  );
};

const isCustomDrills: Check = (v) =>
  Array.isArray(v) &&
  v.every((d: unknown) => {
    if (typeof d !== "object" || d === null) return false;
    const c = d as Record<string, unknown>;
    return isStr(c.id) && isStr(c.text);
  });

const PREF_SHAPE: Readonly<Record<keyof Prefs, Check>> = {
  deviceId: isStr,
  profileId: isStr,
  currentId: isStr,
  session: isSession,
  practicing: isBool,
  landingSeen: isNum,
  settingsOpen: isBool,
  configTab: isStr,
  keyerWpm: isNum,
  gainDb: isNum,
  tolerance: isNum,
  charWpm: isNum,
  farnsworthWpm: isNum,
  expected: isStr,
  view: isStr,
  ppu: isNum,
  times: isNum,
  collapseRests: isBool,
  paceCursor: isBool,
  paceLeadSec: isNum,
  breakSec: isNum,
  paceAbsolute: isBool,
  charMarkers: isBool,
  runScores: isBool,
  advancedGrading: isBool,
  ignoreConstruction: isBool,
  showDownloads: isBool,
  showHints: isBool,
  showChartControls: isBool,
  showRuns: oneOf("all", "last5", "last3", "last"),
  captionAll: isBool,
  zenMode: isBool,
  plainFollow: isBool,
  plainGrading: isBool,
  zenProgress: isBool,
  zenGrading: isBool,
  runSort: isStr,
  user: isUser,
  customDrills: isCustomDrills,
  page: oneOf("practice", "copy", "qso"),
  qsoCopy: oneOf("strict", "lenient"),
  qsoLength: oneOf("full", "short", "pieces", "mixed"),
  qsoTheirText: oneOf("before", "sent", "hidden", "copy", "none"),
  qsoCopyInput: oneOf("text", "slots"),
  qsoGuide: oneOf("cq", "cwt", "sst", "mst", "pota"),
  qsoSideGuide: isBool,
  qsoBlurCall: isBool,
  qsoReplay: isBool,
  qsoYourText: oneOf("sent", "hidden", "none"),
  qsoHints: oneOf("off", "always", "copied"),
  qsoGradeTyping: isBool,
  qsoAllowEdits: isBool,
  qsoPlayback: oneOf("never", "always", "end"),
  qsoShowDownload: isBool,
  qsoSettingsOpen: isBool,
  qsoLockCopy: isBool,
  qsoLockedShows: oneOf("nothing", "grade", "right"),
  qsoShowSpeed: isBool,
  qsoShowTheirSpeed: isBool,
  copySettingsOpen: isBool,
  copyInput: oneOf("text", "slots"),
  copyLines: oneOf("copy", "sent", "before"),
  copyLock: isBool,
  copyLockedShows: oneOf("nothing", "grade", "right"),
  copyHideCalls: isBool,
  copyFollow: isBool,
  copyGradeTyping: isBool,
  copySeekSlot: isBool,
  copyEarlier: oneOf("all", "last", "none"),
  copyKind: oneOf("cq", "cwt", "sst", "mst", "pota"),
  copyRunQsos: isNum,
  copyChatLength: oneOf("full", "short", "pieces"),
  copyGap: oneOf("1", "2", "3", "5", "wait"),
  copySpeed: oneOf("format", "mine"),
  copyCharWpm: isNum,
  copyFarnsworthWpm: isNum,
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

/** The speed you practice at, or null when none is saved. The practice page
 *  and calibration both read and write this one pair. */
export function loadSpeed(): { charWpm: number; farnsworthWpm: number } | null {
  const p = loadPrefs();
  const charWpm = p.charWpm ?? p.keyerWpm;
  if (!charWpm || !(charWpm > 0)) return null;
  const farnsworthWpm = p.farnsworthWpm && p.farnsworthWpm > 0 ? p.farnsworthWpm : charWpm;
  return { charWpm, farnsworthWpm: Math.min(farnsworthWpm, charWpm) };
}

export function saveSpeed(charWpm: number, farnsworthWpm: number): void {
  savePrefs({ ...loadPrefs(), charWpm, farnsworthWpm: Math.min(farnsworthWpm, charWpm) });
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
    opening = openTakeStore().then(
      (store) => {
        /* The connection closes for a newer version's upgrade. The next call
           opens again, not on the closed one. */
        store.onClose(() => {
          opening = null;
        });
        return store;
      },
      (e: unknown) => {
        opening = null;
        throw e;
      },
    );
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

/** Say whether the practice screen is open with nothing recorded in it, so a
 *  reload can come back to it. */
export function rememberPracticing(on: boolean): void {
  const next = { ...loadPrefs() };
  if (on) next.practicing = true;
  else delete next.practicing;
  savePrefs(next);
}

/** Say whether the settings panel is open, so a reload can open it again. */
export function rememberSettingsOpen(open: boolean): void {
  const next = { ...loadPrefs() };
  if (open) next.settingsOpen = true;
  else delete next.settingsOpen;
  savePrefs(next);
}

/** Say which landing screen this visitor has passed through. */
export function rememberLandingSeen(version: number): void {
  if (loadPrefs().landingSeen === version) return;
  savePrefs({ ...loadPrefs(), landingSeen: version });
}

/** The newest landing screen this visitor has passed through, or 0. */
export function recallLandingSeen(): number {
  return loadPrefs().landingSeen ?? 0;
}

/* Per tab, not per visitor. Going back to the landing screen is a decision,
   and a reload keeps it; a new visit still passes the landing screen by. */
const LANDING_ASKED_KEY = "cwt:landing";

/** Say whether the landing screen was asked for in this tab. */
export function rememberLandingAsked(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(LANDING_ASKED_KEY, "1");
    else sessionStorage.removeItem(LANDING_ASKED_KEY);
  } catch {
    // No session storage: a reload passes the landing screen by.
  }
}

/** Whether the landing screen was asked for in this tab. */
export function recallLandingAsked(): boolean {
  try {
    return sessionStorage.getItem(LANDING_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether the practice screen was open with nothing recorded in it. */
export function recallPracticing(): boolean {
  return loadPrefs().practicing === true;
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

/* ---- the QSO page's overs ------------------------------------------------ */

/* Your overs on the QSO page, as recorded, so a reload can still play them.
 * Kept by the line of the log they are, for as long as the log is: a new
 * session clears both. Sixteen-bit, as a take's audio is. */

/** How many overs are kept. An over is about half a megabyte once the wait
 *  before it is cut, so this is a long session's worth and a hard bound. */
export const KEEP_QSO_OVERS = 60;

export interface QsoOver {
  readonly line: number;
  readonly rate: number;
  readonly samples: Int16Array;
}

/** Keep over `line`. The oldest go past `KEEP_QSO_OVERS`. */
export async function keepQsoOver(line: number, samples: Float32Array, rate: number): Promise<void> {
  try {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767);
    }
    const db = await openDb();
    await txIn(db, QSO_OVERS, "readwrite", (s) => s.put({ line, rate, samples: pcm } satisfies QsoOver));
    const lines = await txIn<number[]>(db, QSO_OVERS, "readonly", (s) => s.getAllKeys() as IDBRequest<number[]>);
    for (const old of lines.slice(0, Math.max(0, lines.length - KEEP_QSO_OVERS))) {
      await txIn(db, QSO_OVERS, "readwrite", (s) => s.delete(old));
    }
    db.close();
  } catch {
    /* nothing kept; the over still plays until a reload */
  }
}

/** The overs kept, by line, as samples from -1 to 1. */
export async function recallQsoOvers(): Promise<Map<number, { samples: Float32Array; rate: number }>> {
  const out = new Map<number, { samples: Float32Array; rate: number }>();
  try {
    const db = await openDb();
    const rows = await txIn<QsoOver[]>(db, QSO_OVERS, "readonly", (s) => s.getAll());
    db.close();
    for (const r of rows) out.set(r.line, { samples: Float32Array.from(r.samples, (x) => x / 32767), rate: r.rate });
  } catch {
    /* none */
  }
  return out;
}

/** Forget every over kept: the log they belong to has gone. */
export async function forgetQsoOvers(): Promise<void> {
  try {
    const db = await openDb();
    await txIn(db, QSO_OVERS, "readwrite", (s) => s.clear());
    db.close();
  } catch {
    /* as above */
  }
}

/* The QSO page's log, so a reload comes back to it. Kept apart from the
   preferences: it changes with every key typed into a copy. */
const QSO_KEY = "cwt:qso";

/** Remember the QSO page's log, or forget it with null. */
export function rememberQso(log: unknown): void {
  try {
    if (log === null) localStorage.removeItem(QSO_KEY);
    else localStorage.setItem(QSO_KEY, JSON.stringify(log));
  } catch {
    /* nothing kept; the page still works */
  }
}

/** The QSO page's log as last remembered, unchecked, or null. */
export function recallQso(): unknown {
  try {
    const raw = localStorage.getItem(QSO_KEY);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/* ---- the Copy page's recording ------------------------------------------- */

/* The recording the Copy page is on, so a reload comes back to it: the file
 * as it was opened, and what the decoder read from it. One at a time. A
 * generated QSO keeps its script too, so a change of speed can send it again. */

export interface CopyFile {
  readonly name: string;
  /** The file's own bytes. */
  readonly audio: Blob;
  /** What the decoder read, as the page holds it. */
  readonly recording: unknown;
  /** A generated QSO's script. Absent for a recording opened. */
  readonly script?: unknown;
}

/** Keep `file` as the Copy page's recording, in place of any before it. */
export async function keepCopyFile(file: CopyFile): Promise<void> {
  try {
    const db = await openDb();
    await txIn(db, COPY_FILE, "readwrite", (s) => s.put({ id: "current", ...file }));
    db.close();
  } catch {
    /* nothing kept; the page still works until a reload */
  }
}

/** The Copy page's recording, or null. */
export async function recallCopyFile(): Promise<CopyFile | null> {
  try {
    const db = await openDb();
    const row = await txIn<(CopyFile & { id: string }) | undefined>(db, COPY_FILE, "readonly", (s) =>
      s.get("current"),
    );
    db.close();
    return row && row.audio instanceof Blob && typeof row.name === "string" ? row : null;
  } catch {
    return null;
  }
}

/** Forget the Copy page's recording. */
export async function forgetCopyFile(): Promise<void> {
  try {
    const db = await openDb();
    await txIn(db, COPY_FILE, "readwrite", (s) => s.delete("current"));
    db.close();
  } catch {
    /* nothing to forget */
  }
}

/* Your copy on the Copy page, so a reload comes back to it. Kept apart from
   the recording: it changes with every key typed. */
const COPY_KEY = "cwt:copy";

/** Remember your copy on the Copy page, or forget it with null. */
export function rememberCopy(progress: unknown): void {
  try {
    if (progress === null) localStorage.removeItem(COPY_KEY);
    else localStorage.setItem(COPY_KEY, JSON.stringify(progress));
  } catch {
    /* nothing kept; the page still works */
  }
}

/** Your copy on the Copy page as last remembered, unchecked, or null. */
export function recallCopy(): unknown {
  try {
    const raw = localStorage.getItem(COPY_KEY);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
