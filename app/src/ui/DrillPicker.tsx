/* A button that opens the drill catalog as a tree.
 *
 * Not a <select>: an <optgroup> holds one level of header, and a drill sits
 * under two. A tree rather than a listbox, because a group collapses, and a
 * listbox has no row the keyboard can collapse it from. The keys are the ones
 * a palette will take: arrows, Enter, Escape and type-ahead, plus Left and
 * Right to collapse and expand a group.
 *
 * Enter and Escape stop here. The dialog around the picker reads both, as
 * "start the session" and "close the dialog". */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { groupDrills, type Drill, type DrillGroup } from "@/drills";

export interface DrillPickerProps {
  drills: readonly Drill[];
  onPick(drill: Drill): void;
  /** Float the list over the page instead of taking room in the layout. */
  floating?: boolean;
}

/** One row the keyboard can land on. */
type Row =
  | { kind: "group"; key: string; group: DrillGroup }
  | { kind: "drill"; key: string; drill: Drill; groupKey: string };

const TYPEAHEAD_MS = 600;
/** Height of the sticky group header in base.css. */
const STICKY_PX = 28;
const VIEWPORT_GUTTER_PX = 16;

const groupKey = (g: DrillGroup) => `group:${g.name}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function DrillPicker({ drills, onPick, floating = false }: DrillPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const prefix = useId();

  const groups = useMemo(() => groupDrills(drills), [drills]);
  const rows = useMemo<Row[]>(
    () =>
      groups.flatMap((g) => {
        const key = groupKey(g);
        const head: Row = { kind: "group", key, group: g };
        if (collapsed.has(key)) return [head];
        const items = g.sections.flatMap((s) =>
          s.drills.map((d): Row => ({ kind: "drill", key: d.id, drill: d, groupKey: key })),
        );
        return [head, ...items];
      }),
    [groups, collapsed],
  );
  const [activeKey, setActiveKey] = useState<string | undefined>(
    () => rows.find((r) => r.kind === "drill")?.key ?? rows[0]?.key,
  );
  const activeAt = Math.max(0, rows.findIndex((r) => r.key === activeKey));
  const active = rows[activeAt];
  const rowId = (key: string) => `${prefix}-${slug(key)}`;

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

  // Shift a floating list left when it would run off the right edge.
  useLayoutEffect(() => {
    const l = list.current;
    if (!open || !floating || !l) return;
    l.style.left = "0px";
    const over = l.getBoundingClientRect().right - (window.innerWidth - VIEWPORT_GUTTER_PX);
    if (over > 0) l.style.left = `${-over}px`;
  }, [open, floating]);

  /* By hand rather than scrollIntoView, which also scrolls the dialog, and
     which cannot allow for the sticky group header. A group row is measured
     by its header only: the element holds the whole group. */
  useEffect(() => {
    const l = list.current;
    const el = active && document.getElementById(rowId(active.key));
    if (!open || !l || !el) return;
    const isGroup = active.kind === "group";
    const top = el.offsetTop - (isGroup ? 0 : STICKY_PX);
    const bottom = el.offsetTop + (isGroup ? STICKY_PX : el.offsetHeight);
    if (top < l.scrollTop) l.scrollTop = top;
    else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight;
  }, [open, active]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const pick = (d: Drill) => {
    setOpen(false);
    onPick(d);
  };

  const setGroupOpen = (key: string, expand: boolean) => {
    setCollapsed((c) => {
      const next = new Set(c);
      if (expand) next.delete(key);
      else next.add(key);
      return next;
    });
    // A drill that is about to be hidden hands the focus to its group.
    if (!expand && active?.kind === "drill" && active.groupKey === key) setActiveKey(key);
  };

  const toggle = (key: string) => setGroupOpen(key, collapsed.has(key));

  /** Whether a type-ahead search is still being typed. */
  const typing = () => Date.now() - typed.current.at < TYPEAHEAD_MS;

  const typeahead = (ch: string) => {
    const t = typed.current;
    t.text = typing() ? t.text + ch : ch;
    t.at = Date.now();
    // A fresh search starts after the active row; a longer one may keep it.
    const start = t.text.length > 1 ? activeAt : activeAt + 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[(start + i) % rows.length]!;
      if (r.kind === "drill" && r.drill.text.startsWith(t.text)) {
        setActiveKey(r.key);
        return;
      }
    }
  };

  const activate = () => {
    if (!active) return;
    if (active.kind === "group") toggle(active.key);
    else pick(active.drill);
  };

  const move = (to: number) => {
    const r = rows[Math.min(Math.max(to, 0), rows.length - 1)];
    if (r) setActiveKey(r.key);
  };

  const onTreeKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": move(activeAt + 1); break;
      case "ArrowUp": move(activeAt - 1); break;
      case "Home": move(0); break;
      case "End": move(rows.length - 1); break;
      case "ArrowRight":
        if (active?.kind !== "group") break;
        if (collapsed.has(active.key)) setGroupOpen(active.key, true);
        else move(activeAt + 1);
        break;
      case "ArrowLeft":
        if (active?.kind === "drill") setActiveKey(active.groupKey);
        else if (active && !collapsed.has(active.key)) setGroupOpen(active.key, false);
        break;
      case "Enter": activate(); break;
      case "Escape": close(); break;
      case "Tab": close(); return;
      default:
        if (e.key === " " && !typing()) {
          activate();
          break;
        }
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
    <div className={floating ? "drillpicker floating" : "drillpicker"} ref={root}>
      <button
        ref={button}
        type="button"
        data-testid="drill-picker"
        aria-haspopup="tree"
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
          role="tree"
          aria-label="Drills"
          tabIndex={-1}
          aria-activedescendant={active ? rowId(active.key) : undefined}
          onKeyDown={onTreeKey}
        >
          {groups.map((g) => {
            const key = groupKey(g);
            const expanded = !collapsed.has(key);
            return (
              <div
                key={key}
                id={rowId(key)}
                role="treeitem"
                aria-level={1}
                aria-expanded={expanded}
                aria-selected={active?.key === key}
                aria-labelledby={`${rowId(key)}-name`}
              >
                <div
                  id={`${rowId(key)}-name`}
                  className="drillgroup"
                  data-active={active?.key === key}
                  data-testid={`drill-group-${slug(g.name)}`}
                  onClick={() => {
                    setActiveKey(key);
                    toggle(key);
                  }}
                >
                  {/* The select chevron, turned to point right while collapsed. */}
                  <svg className="caret" viewBox="0 0 10 6" aria-hidden="true">
                    <path d="M1 1l4 4 4-4" />
                  </svg>
                  {g.name}
                </div>
                {expanded && (
                  <div role="group">
                    {g.sections.map((s) => (
                      <div key={s.name} role="group" aria-label={`${g.name} › ${s.name}`}>
                        <div role="presentation" className="drillsection">
                          {s.name}
                        </div>
                        {s.drills.map((d) => (
                          <div
                            key={d.id}
                            id={rowId(d.id)}
                            role="treeitem"
                            aria-level={2}
                            aria-selected={active?.key === d.id}
                            data-active={active?.key === d.id}
                            data-testid={`drill-option-${d.id}`}
                            title={d.text}
                            onMouseMove={() => setActiveKey(d.id)}
                            onClick={() => pick(d)}
                          >
                            {d.text}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
