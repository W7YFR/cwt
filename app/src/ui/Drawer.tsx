/* A panel over the right side of the page, the whole page on a phone: what
 * Settings and Help are drawn in. It slides in, and out again on Esc, on its
 * close button, or on a click beside it. */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How long the drawer takes to slide out; see `.drawerwrap`. */
const CLOSE_MS = 90;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function Drawer({
  open,
  onClose,
  title,
  id,
  testId,
  tabs,
  bodyTab,
  children,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  id: string;
  testId: string;
  /** The row of tabs under the title. */
  tabs?: React.ReactNode;
  /** Which tab is on show, for the body's `data-tab`. */
  bodyTab?: string;
  children: React.ReactNode;
}): React.ReactElement | null {
  const drawer = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(null);
  /* In the page while open, and for as long as it takes to slide out. */
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), reducedMotion() ? 0 : CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    drawer.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;
  /* On the body, so nothing on the page can confine it. */
  return createPortal(
    <div className="drawerwrap" data-state={open ? "open" : "closing"}>
      <div className="drawerscrim" onClick={onClose} />
      <div
        className="drawer"
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={drawer}
        data-testid={testId}
      >
        <div className="drawerhead">
          <h2>{title}</h2>
          <button className="iconbtn drawerclose" aria-label={`Close ${title.toLowerCase()}`} title="Close · Esc" onClick={onClose}>
            ×
          </button>
        </div>
        {tabs}
        <div className="drawerbody" data-tab={bodyTab}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A row of tabs for a drawer. */
export function DrawerTabs({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="drawertabs" role="tablist" aria-label={label} data-testid={testId}>
      {children}
    </div>
  );
}
