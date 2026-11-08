/* Settings: one drawer, behind one button, on every screen.
 *
 * The drawer has the same tabs in the same order everywhere. First come the
 * page's own tabs (the page, Typing, Sound, Speed), then the tabs that
 * belong to the whole app (Microphone, You, Drills). A page fills its tabs
 * from its own state through a portal, so nothing a page sets moves out of
 * the page. The app fills the rest.
 */

import { Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCog } from "./Icons";
import { SettingsForm } from "./Controls";
import type { InputDevice } from "@/capture/mic";
import type { Profile } from "@/io/profiles";

/** Every tab, in the order the drawer shows them. */
export type SettingsTab = "page" | "copy" | "sound" | "speed" | "microphone" | "you" | "drills";
const ORDER: readonly SettingsTab[] = ["page", "copy", "sound", "speed", "microphone", "you", "drills"];
/** The app's own tabs, on every screen. */
const EVERY_PAGE = "The same on every page.";
const APP_TABS: readonly PageTab[] = [
  { id: "microphone", label: "Microphone", scope: EVERY_PAGE },
  { id: "you", label: "You", scope: EVERY_PAGE },
  { id: "drills", label: "Drills", scope: EVERY_PAGE },
];
const isApp = (id: SettingsTab) => APP_TABS.some((a) => a.id === id);

interface PageTab {
  id: SettingsTab;
  label: string;
  /** Where its settings apply, said at the top of the tab. */
  scope?: string;
}

interface Host {
  open: boolean;
  tab: SettingsTab;
  /** Open the drawer at a tab, or at the one last open. */
  show(tab?: SettingsTab): void;
  close(): void;
  toggle(): void;
  setTab(tab: SettingsTab): void;
  /** Where a page draws the tab on show. */
  slot: HTMLElement | null;
  setSlot(el: HTMLElement | null): void;
  pageTabs: readonly PageTab[];
  setPageTabs(tabs: readonly PageTab[] | null): void;
  /** The page's tabs are open but not to be changed: a take is recording. */
  locked: boolean;
  setLocked(locked: boolean): void;
}

const SettingsHost = createContext<Host | null>(null);

/** Outside the app, as when a test draws one screen alone: a drawer that
 *  never opens. */
const NO_HOST: Host = {
  open: false,
  tab: "page",
  show: () => {},
  close: () => {},
  toggle: () => {},
  setTab: () => {},
  slot: null,
  setSlot: () => {},
  pageTabs: [],
  setPageTabs: () => {},
  locked: false,
  setLocked: () => {},
};

export function useSettings(): Host {
  return useContext(SettingsHost) ?? NO_HOST;
}

export function SettingsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [tab, setTabRaw] = useState<SettingsTab>("page");
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [pageTabs, setPageTabsRaw] = useState<readonly PageTab[]>([]);
  const [locked, setLocked] = useState(false);
  const setPageTabs = useCallback((tabs: readonly PageTab[] | null) => setPageTabsRaw(tabs ?? []), []);
  const show = useCallback((at?: SettingsTab) => {
    if (at) setTabRaw(at);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const host = useMemo<Host>(
    () => ({ open, tab, show, close, toggle, setTab: setTabRaw, slot, setSlot, pageTabs, setPageTabs, locked, setLocked }),
    [open, tab, show, close, toggle, slot, pageTabs, setPageTabs, locked],
  );
  return <SettingsHost.Provider value={host}>{children}</SettingsHost.Provider>;
}

/** The tabs on show: the page's, then the app's, in the fixed order. */
function tabsOf(pageTabs: readonly PageTab[]): PageTab[] {
  const all = [
    ...pageTabs.filter((p) => !isApp(p.id)),
    ...APP_TABS,
  ];
  return ORDER.flatMap((id) => all.filter((t) => t.id === id));
}

/** The tab on show. One this screen does not have falls back to the first. */
function tabOn(host: Host): SettingsTab {
  const tabs = tabsOf(host.pageTabs);
  return tabs.some((t) => t.id === host.tab) ? host.tab : tabs[0]!.id;
}

/** How long the drawer takes to slide out; see `.drawerwrap`. */
const CLOSE_MS = 90;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** The ⚙ button, at the right end of every header. */
export function SettingsButton(): React.ReactElement {
  const host = useSettings();
  return (
    <button
      className="iconbtn cornerbtn"
      data-testid="panel-toggle"
      aria-pressed={host.open}
      aria-controls="settings-drawer"
      aria-label="Settings"
      title="Settings"
      onClick={host.toggle}
    >
      <IconCog />
    </button>
  );
}

/** The microphone in use and whether it is calibrated, in the header of a
 *  page that records. Opens Settings at Microphone. */
export function MicChip({
  devices,
  deviceId,
  profiles,
  profileId,
  applies = true,
}: {
  devices: readonly InputDevice[];
  deviceId: string | undefined;
  profiles: readonly Profile[];
  profileId: string | undefined;
  /** False for a recording opened from a file, which no calibration
   *  corrects. */
  applies?: boolean;
}): React.ReactElement {
  const host = useSettings();
  const active = profiles.find((p) => p.id === profileId) ?? null;
  const input = devices.find((d) => d.deviceId === deviceId)?.label ?? devices[0]?.label ?? "Default input";
  const state = !applies ? "Not corrected" : active ? "Calibrated" : "Not calibrated";
  return (
    <button
      className={`calchip micchip ${applies && active ? "ok" : "none"}`}
      data-testid="mic-chip"
      data-state={!applies ? "file" : active ? "active" : "none"}
      title={`${input} · ${active ? `calibrated as “${active.nickname}”` : "not calibrated"}. Change it in Settings.`}
      onClick={() => host.show("microphone")}
    >
      <span className="dot" aria-hidden="true" />
      <span className="micname">{input}</span>
      <span aria-hidden="true">·</span>
      <span>{state}</span>
    </button>
  );
}

/** The drawer. `app` draws the app's tabs; a page draws its own through
 *  `PageSettings`. */
export function SettingsDrawer({
  app,
}: {
  /** The content of an app tab, by id. A page's part of the same tab, if it
   *  has one, comes first. */
  app(tab: SettingsTab): React.ReactNode;
}): React.ReactElement | null {
  const host = useSettings();
  const tabs = tabsOf(host.pageTabs);
  const tab = tabOn(host);
  const scope = tabs.find((t) => t.id === tab)?.scope;
  const pageOwns = host.pageTabs.some((t) => t.id === tab);
  const drawer = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(null);
  /* In the page while open, and for as long as it takes to slide out. */
  const [mounted, setMounted] = useState(host.open);
  useEffect(() => {
    if (host.open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), reducedMotion() ? 0 : CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [host.open]);

  useEffect(() => {
    if (!host.open) return;
    opener.current = document.activeElement;
    drawer.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      host.close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      (opener.current as HTMLElement | null)?.focus?.();
    };
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.open]);

  if (!mounted) return null;
  const appPart = app(tab);
  /* On the body, so nothing on the page can confine it. */
  return createPortal(
    <div className="drawerwrap" data-state={host.open ? "open" : "closing"}>
      <div className="drawerscrim" onClick={host.close} />
      <div
        className="drawer"
        id="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        ref={drawer}
        data-testid="settings"
      >
        <div className="drawerhead">
          <h2>Settings</h2>
          <button className="iconbtn drawerclose" aria-label="Close settings" title="Close · Esc" onClick={host.close}>
            ×
          </button>
        </div>
        <div className="drawertabs" role="tablist" aria-label="Settings section" data-testid="settings-tab">
          {tabs.map((t, i) => (
            <Fragment key={t.id}>
            {i > 0 && isApp(t.id) && !isApp(tabs[i - 1]!.id) && <span className="tabsep" aria-hidden="true" />}
            <button
              role="tab"
              data-tab={t.id}
              aria-selected={t.id === tab}
              onClick={() => host.setTab(t.id)}
            >
              {t.label}
            </button>
            </Fragment>
          ))}
        </div>
        <div className="drawerbody" data-tab={tab}>
          {scope && <p className="drawerscope">{scope}</p>}
          {pageOwns && host.locked && <p className="drawerlock">Can't change these while recording.</p>}
          <div className="drawerslot" ref={host.setSlot} inert={pageOwns && host.locked} data-locked={pageOwns && host.locked} />
          {appPart}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export interface PageSettingsTab {
  id: SettingsTab;
  label: string;
  /** Where its settings apply, said at the top of the tab. */
  scope?: string;
  content: React.ReactNode;
}

/** A page's tabs. Drawn into the drawer while one of them is on show, and
 *  nowhere otherwise. */
export function PageSettings({
  tabs,
  locked = false,
}: {
  tabs: readonly PageSettingsTab[];
  /** Shown, but not to be changed: a take is recording. */
  locked?: boolean;
}): React.ReactElement | null {
  const host = useSettings();
  const { setPageTabs, setLocked } = host;
  const key = tabs.map((t) => `${t.id}:${t.label}:${t.scope ?? ""}`).join("|");
  useLayoutEffect(() => {
    setPageTabs(tabs.map(({ id, label, scope }) => ({ id, label, ...(scope ? { scope } : {}) })));
    return () => setPageTabs(null);
    // The labels are what matter, and `key` holds them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setPageTabs]);
  useLayoutEffect(() => {
    setLocked(locked);
    return () => setLocked(false);
  }, [locked, setLocked]);
  const active = tabs.find((t) => t.id === tabOn(host));
  // The slot is there only while the drawer is, closing included.
  if (!host.slot || !active) return null;
  return createPortal(<SettingsForm>{active.content}</SettingsForm>, host.slot);
}
