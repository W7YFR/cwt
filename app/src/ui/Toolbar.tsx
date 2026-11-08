/* The toolbar: the second row of every page's header.
 *
 * The same three parts on every page. First the page's actions, the main one
 * first. Then its quick settings, each a chip that shows its value and opens
 * the setting itself. Last, ⋯ for what is done rarely, such as opening a file
 * or saving one.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SettingsForm } from "./Controls";
import { IconDownload, IconUpload } from "./Icons";
import { useSettings, type SettingsTab } from "./SettingsDrawer";

/** The least room kept between a popover and the window's edge. */
const EDGE_PX = 16;

export function Toolbar({
  actions,
  chips,
  more,
}: {
  actions: React.ReactNode;
  chips?: React.ReactNode;
  /** The ⋯ menu's items. Absent, there is no menu. */
  more?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="toolbar" data-testid="toolbar">
      <div className="toolactions">{actions}</div>
      {chips && (
        <div className="toolchips" role="group" aria-label="Quick settings">
          {chips}
        </div>
      )}
      {more && <MoreMenu>{more}</MoreMenu>}
    </div>
  );
}

/** Open while `open`; closed by a click outside it, or by Esc. */
function usePopover(open: boolean, close: () => void, root: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open, close, root]);
}

/** Shift a popover left when it would run off the right edge, as the drill
 *  list does. */
function useInView(open: boolean, pop: React.RefObject<HTMLElement | null>, pin = false): void {
  useLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el) return;
    /* Held at the width it opened at, so changing a setting inside it never
       moves it: what grows wraps instead. */
    if (pin && !el.style.width) el.style.width = `${el.offsetWidth}px`;
    if (pin) el.dataset.pinned = "true";
    el.style.left = "0px";
    const over = el.getBoundingClientRect().right - (document.documentElement.clientWidth - EDGE_PX);
    if (over > 0) el.style.left = `${-over}px`;
  }, [open, pop]);
}

/** The name column as wide as the longest name in the popover, and gone
 *  when no row has a name: a popover holds a few settings, and a column
 *  sized for the whole of Settings leaves most of it empty. */
function useNameColumn(open: boolean, pop: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = pop.current;
    const form = el?.querySelector<HTMLElement>(".viewpanel.formpanel");
    if (!open || !form) return;
    const names = form.querySelectorAll<HTMLElement>(
      ".group > .caption, .group > label:not(.check):not(.field), .group > label.field > .fieldname",
    );
    /* A slider's name sits on its own line above it, so it takes no column. */
    const inColumn = [...names].filter((n) => !n.parentElement?.querySelector(':scope > input[type="range"]'));
    const widest = Math.max(0, ...inColumn.map((n) => Math.ceil(n.scrollWidth)));
    form.style.setProperty("--namecol", `${widest}px`);
    form.dataset.names = String(widest > 0);
  }, [open, pop]);
}

/** The longest of some values, for a chip's `widest`. */
export function longest(values: readonly string[]): string {
  return values.reduce((a, b) => (b.length > a.length ? b : a), "");
}

/** The widest a speed reads, as 45/45 wpm. */
export const WIDEST_SPEED = "45/45 wpm";

/** One quick setting: its name and value, and the setting itself a click
 *  away. The popover links to the setting's tab in Settings. */
export function QuickChip({
  id,
  label,
  value,
  tab,
  locked = false,
  widest,
  width,
  children,
}: {
  id: string;
  label: string;
  /** What it is set to, short. */
  value: string;
  /** Where the rest of its settings are. */
  tab: SettingsTab;
  /** Shown, but not to be changed: a take is recording. */
  locked?: boolean;
  /** The longest value it can show. Its room is kept, so the chips beside it
   *  do not move when it changes. */
  widest?: string;
  /** A fixed width for the popover, for one whose settings change shape with
   *  its value, as Mode's do. Otherwise it keeps the width it opened at. */
  width?: number;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const settings = useSettings();
  const close = useRef(() => setOpen(false)).current;
  usePopover(open, close, root);
  useNameColumn(open, pop);
  useInView(open, pop, true);
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);
  return (
    <div className="quick" ref={root}>
      <button
        type="button"
        className="chip"
        data-testid={`chip-${id}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={locked}
        title={locked ? "Can't change this while recording" : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="chipname">{label}</span>
        <span className="chipvalue" style={widest ? { minWidth: `${Math.max(widest.length, value.length)}ch` } : undefined}>
          {value}
        </span>
        <span className="chipcaret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="quickpop"
          ref={pop}
          role="dialog"
          aria-label={label}
          data-testid={`pop-${id}`}
          style={width ? { width } : undefined}
        >
          <SettingsForm>{children}</SettingsForm>
          <button
            type="button"
            className="link quickmore"
            onClick={() => {
              setOpen(false);
              settings.show(tab);
            }}
          >
            More in Settings ›
          </button>
        </div>
      )}
    </div>
  );
}

/** ⋯: what is done rarely. Its items are buttons; a click on one closes it. */
function MoreMenu({ children }: { children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = useRef(() => setOpen(false)).current;
  usePopover(open, close, root);
  useInView(open, pop);
  return (
    <div className="quick more" ref={root}>
      <button
        type="button"
        className="iconbtn"
        data-testid="more"
        aria-label="More"
        title="More"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div
          className="quickpop menu"
          ref={pop}
          role="menu"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("button")) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A heading inside ⋯, over a few of its items. */
export function MenuHeading({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="menuhead">{children}</div>;
}

/** An item in ⋯ that opens a file. The file dialog is the only part of the
 *  hidden input anyone sees, so it is kept out of the tab order. */
export function OpenFileItem({
  label,
  accept,
  disabled = false,
  title,
  testId,
  onFile,
}: {
  label: string;
  accept: string;
  disabled?: boolean;
  title?: string;
  testId?: string;
  onFile(file: File): void;
}): React.ReactElement {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        role="menuitem"
        data-testid={testId}
        disabled={disabled}
        title={title}
        onClick={() => input.current?.click()}
      >
        <IconUpload /> {label}
      </button>
      <input
        ref={input}
        className="visually-hidden"
        tabIndex={-1}
        type="file"
        accept={accept}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** An item in ⋯ that saves a file. */
export function DownloadItem({
  label,
  disabled = false,
  title,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  title?: string;
  onClick(): void;
}): React.ReactElement {
  return (
    <button type="button" role="menuitem" disabled={disabled} title={title} onClick={onClick}>
      <IconDownload /> {label}
    </button>
  );
}
