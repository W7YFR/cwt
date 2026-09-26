/* A button that opens the drill catalog as a grouped listbox.
 *
 * Not a <select>: an <optgroup> holds one level of header, and a drill sits
 * under two. The listbox takes the keys a palette will: arrows, Enter, Escape
 * and type-ahead.
 *
 * Enter and Escape stop here. The dialog around the picker reads both, as
 * "start the session" and "close the dialog". */

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { groupDrills, type Drill } from "@/drills";

export interface DrillPickerProps {
  drills: readonly Drill[];
  onPick(drill: Drill): void;
}

const TYPEAHEAD_MS = 600;
/** Height of the sticky group header in base.css. */
const STICKY_PX = 28;

export function DrillPicker({ drills, onPick }: DrillPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const prefix = useId();

  const groups = useMemo(() => groupDrills(drills), [drills]);
  const order = useMemo(
    () => groups.flatMap((g) => g.sections.flatMap((s) => s.drills)),
    [groups],
  );
  const optionId = (d: Drill) => `${prefix}-${d.id}`;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.focus({ preventScroll: true });
  }, [open]);

  /* By hand rather than scrollIntoView, which also scrolls the dialog, and
     which cannot allow for the sticky group header. */
  useEffect(() => {
    const d = order[active];
    const l = list.current;
    const el = d && document.getElementById(optionId(d));
    if (!open || !l || !el) return;
    const top = el.offsetTop - STICKY_PX;
    const bottom = el.offsetTop + el.offsetHeight;
    if (top < l.scrollTop) l.scrollTop = top;
    else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight;
  }, [open, active, order]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const pick = (d: Drill) => {
    setOpen(false);
    onPick(d);
  };

  const typeahead = (ch: string) => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at < TYPEAHEAD_MS ? t.text + ch : ch;
    t.at = now;
    // A fresh search starts after the active option; a longer one may keep it.
    const start = t.text.length > 1 ? active : active + 1;
    for (let i = 0; i < order.length; i++) {
      const j = (start + i) % order.length;
      if (order[j]!.text.startsWith(t.text)) {
        setActive(j);
        return;
      }
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const last = order.length - 1;
    const d = order[active];
    switch (e.key) {
      case "ArrowDown": setActive((i) => Math.min(i + 1, last)); break;
      case "ArrowUp": setActive((i) => Math.max(i - 1, 0)); break;
      case "Home": setActive(0); break;
      case "End": setActive(last); break;
      case "Enter": if (d) pick(d); break;
      case "Escape": close(); break;
      case "Tab": close(); return;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          typeahead(e.key.toUpperCase());
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="drillpicker" ref={root}>
      <button
        ref={button}
        type="button"
        data-testid="drill-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.stopPropagation();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        Drill ▾
      </button>
      {open && (
        <div
          ref={list}
          className="drilllist"
          role="listbox"
          aria-label="Drills"
          tabIndex={-1}
          aria-activedescendant={order[active] ? optionId(order[active]) : undefined}
          onKeyDown={onListKey}
        >
          {groups.map((g) => (
            <Fragment key={g.name}>
              <div role="presentation" className="drillgroup">
                {g.name}
              </div>
              {g.sections.map((s) => (
                <div key={s.name} role="group" aria-label={`${g.name} › ${s.name}`}>
                  <div role="presentation" className="drillsection">
                    {s.name}
                  </div>
                  {s.drills.map((d) => {
                    const i = order.indexOf(d);
                    return (
                      <div
                        key={d.id}
                        id={optionId(d)}
                        role="option"
                        aria-selected={i === active}
                        data-testid={`drill-option-${d.id}`}
                        title={d.text}
                        onMouseMove={() => setActive(i)}
                        onClick={() => pick(d)}
                      >
                        {d.text}
                      </div>
                    );
                  })}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
