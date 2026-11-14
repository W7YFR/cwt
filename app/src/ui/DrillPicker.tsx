/* A button that opens the drill catalog as a tree.
 *
 * Not a <select>: an <optgroup> holds one level of header, and a drill sits
 * under two. A tree rather than a listbox, because a group and a section
 * collapse, and a listbox has no row the keyboard can collapse them from. The
 * keys are the ones a palette will take: arrows, Enter, Escape and type-ahead,
 * plus Left and Right to collapse and expand a group or a section.
 *
 * Random drill, the first row, picks a drill at random from all of them. The
 * die on a group or a section picks one from it, and so does Shift+Enter on
 * its row. A drill that is missing details is never picked.
 *
 * Every group and section starts collapsed. The ones the user opens stay open
 * the next time the picker opens, and after a reload.
 *
 * Enter and Escape stop here. The dialog around the picker reads both, as
 * "start the session" and "close the dialog". */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SLOT_LABELS, groupDrills, type Drill, type DrillGroup } from "@/drills";
import { loadOpenDrillGroups, saveOpenDrillGroups } from "@/io/storage";
import { IconDice } from "@/ui/Icons";

export interface DrillPickerProps {
  drills: readonly Drill[];
  onPick(drill: Drill): void;
  /** Float the list over the page instead of taking room in the layout. */
  floating?: boolean;
}

/** One row the keyboard can land on. `parent` is the key of the row that
 *  holds it: a drill's section, or its group when the section has no name. */
type Row =
  | { kind: "random"; key: string }
  | { kind: "group"; key: string; group: DrillGroup }
  | { kind: "section"; key: string; name: string; parent: string; drills: Drill[] }
  | { kind: "drill"; key: string; drill: Drill; parent: string };

const TYPEAHEAD_MS = 600;
/** Height of the sticky group header in base.css. */
const STICKY_PX = 28;
/** Height of a section header in base.css. */
const SECTION_PX = 24;
const VIEWPORT_GUTTER_PX = 16;

/* A group or a section is saved as open by its name, and a section's name
   holds its group's: "Pangrams › Short". */
const OPEN = "open:";
const groupKey = (g: DrillGroup) => `${OPEN}${g.name}`;
const sectionKey = (g: DrillGroup, section: string) => `${OPEN}${g.name} › ${section}`;

/** What a drill that cannot be picked yet is waiting for. */
function needs(d: Drill): string | undefined {
  if (!d.missing?.length) return undefined;
  const fields = d.missing.map((s) => SLOT_LABELS[s]).join(", ");
  return `Needs ${fields}. Set them in Settings › Advanced.`;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const RANDOM = "random";

/** The drills a random pick can land on. */
const pickable = (drills: readonly Drill[]) => drills.filter((d) => !d.missing?.length);
const drillsOf = (g: DrillGroup) => g.sections.flatMap((s) => s.drills);

export function DrillPicker({ drills, onPick, floating = false }: DrillPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(loadOpenDrillGroups().map((name) => `${OPEN}${name}`)),
  );
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const prefix = useId();

  const groups = useMemo(() => groupDrills(drills), [drills]);
  const rows = useMemo<Row[]>(
    () => [
      { kind: "random", key: RANDOM },
      ...groups.flatMap((g) => {
        const key = groupKey(g);
        const head: Row = { kind: "group", key, group: g };
        if (!expanded.has(key)) return [head];
        const items = g.sections.flatMap((s): Row[] => {
          const drills = (parent: string) =>
            s.drills.map((d): Row => ({ kind: "drill", key: d.id, drill: d, parent }));
          if (!s.name) return drills(key);
          const sKey = sectionKey(g, s.name);
          const sHead: Row = { kind: "section", key: sKey, name: s.name, parent: key, drills: s.drills };
          return expanded.has(sKey) ? [sHead, ...drills(sKey)] : [sHead];
        });
        return [head, ...items];
      }),
    ],
    [groups, expanded],
  );
  const [activeKey, setActiveKey] = useState<string | undefined>(
    () => (rows.find((r) => r.kind === "drill") ?? rows.find((r) => r.kind === "group"))?.key,
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
     which cannot allow for the sticky group header. A group or a section row
     is measured by its header only: the element holds all that is in it. */
  useEffect(() => {
    const l = list.current;
    const el = active && document.getElementById(rowId(active.key));
    if (!open || !l || !el) return;
    const head = active.kind === "group" || active.kind === "random";
    const top = el.offsetTop - (head ? 0 : STICKY_PX);
    const height = head ? STICKY_PX : active.kind === "section" ? SECTION_PX : el.offsetHeight;
    const bottom = el.offsetTop + height;
    if (top < l.scrollTop) l.scrollTop = top;
    else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight;
  }, [open, active]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const pick = (d: Drill) => {
    if (d.missing?.length) return;
    setOpen(false);
    onPick(d);
  };

  /** Pick one of these drills at random. */
  const pickRandom = (from: readonly Drill[]) => {
    const pool = pickable(from);
    if (pool.length) pick(pool[Math.floor(Math.random() * pool.length)]!);
  };

  /** The die on a group or a section header. */
  const dice = (from: readonly Drill[], name: string, testId: string) => (
    <button
      type="button"
      className="drilldice"
      tabIndex={-1}
      aria-label={`Random drill from ${name}`}
      title={`Random drill from ${name}`}
      data-testid={testId}
      disabled={!pickable(from).length}
      // Keep the focus in the list, where the keys are read.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        pickRandom(from);
      }}
    >
      <IconDice />
    </button>
  );

  const setGroupOpen = (key: string, expand: boolean) => {
    const next = new Set(expanded);
    if (expand) next.add(key);
    else next.delete(key);
    setExpanded(next);
    saveOpenDrillGroups([...next].map((k) => k.slice(OPEN.length)));
    // A row that is about to be hidden hands the focus to the one collapsing.
    if (!expand && active && within(active, key)) setActiveKey(key);
  };

  /** Whether a row sits inside the group or section with this key. A
   *  section's key starts with its group's. */
  const within = (row: Row, key: string): boolean =>
    (row.kind === "section" || row.kind === "drill") &&
    (row.parent === key || row.parent.startsWith(`${key} › `));

  const toggle = (key: string) => setGroupOpen(key, !expanded.has(key));

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
    if (active.kind === "drill") pick(active.drill);
    else if (active.kind === "random") pickRandom(drills);
    else toggle(active.key);
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
        if (!active || active.kind === "drill" || active.kind === "random") break;
        if (!expanded.has(active.key)) setGroupOpen(active.key, true);
        else move(activeAt + 1);
        break;
      case "ArrowLeft":
        if (!active || active.kind === "random") break;
        if (active.kind !== "drill" && expanded.has(active.key)) setGroupOpen(active.key, false);
        else if (active.kind !== "group") setActiveKey(active.parent);
        break;
      case "Enter":
        if (e.shiftKey && active?.kind === "group") pickRandom(drillsOf(active.group));
        else if (e.shiftKey && active?.kind === "section") pickRandom(active.drills);
        else activate();
        break;
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
          <div
            id={rowId(RANDOM)}
            role="treeitem"
            aria-level={1}
            aria-selected={active?.key === RANDOM}
            className="drillgroup drillrandom"
            data-active={active?.key === RANDOM}
            data-testid="drill-random"
            onMouseMove={() => setActiveKey(RANDOM)}
            onClick={() => pickRandom(drills)}
          >
            <IconDice />
            Random drill
          </div>
          {groups.map((g) => {
            const key = groupKey(g);
            const isOpen = expanded.has(key);
            return (
              <div
                key={key}
                id={rowId(key)}
                role="treeitem"
                aria-level={1}
                aria-expanded={isOpen}
                aria-selected={active?.key === key}
                aria-labelledby={`${rowId(key)}-name`}
              >
                <div
                  id={`${rowId(key)}-name`}
                  className="drillgroup"
                  data-active={active?.key === key}
                  data-testid={`drill-group-${slug(g.name)}`}
                  onMouseMove={() => setActiveKey(key)}
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
                  {dice(drillsOf(g), g.name, `drill-random-${slug(g.name)}`)}
                </div>
                {isOpen && (
                  <div role="group">
                    {g.sections.map((s) => {
                      const option = (d: Drill, level: number) => (
                        <div
                          key={d.id}
                          id={rowId(d.id)}
                          role="treeitem"
                          aria-level={level}
                          aria-selected={active?.key === d.id}
                          aria-disabled={d.missing?.length ? true : undefined}
                          className="drill"
                          data-active={active?.key === d.id}
                          data-testid={`drill-option-${d.id}`}
                          title={needs(d) ?? d.text}
                          onMouseMove={() => setActiveKey(d.id)}
                          onClick={() => pick(d)}
                        >
                          {d.text}
                        </div>
                      );
                      if (!s.name) return s.drills.map((d) => option(d, 2));
                      const sKey = sectionKey(g, s.name);
                      const sOpen = expanded.has(sKey);
                      return (
                        <div
                          key={s.name}
                          id={rowId(sKey)}
                          role="treeitem"
                          aria-level={2}
                          aria-expanded={sOpen}
                          aria-selected={active?.key === sKey}
                          aria-label={`${g.name} › ${s.name}`}
                        >
                          <div
                            className="drillsection"
                            data-active={active?.key === sKey}
                            data-testid={`drill-section-${slug(g.name)}-${slug(s.name)}`}
                            onMouseMove={() => setActiveKey(sKey)}
                            onClick={() => {
                              setActiveKey(sKey);
                              toggle(sKey);
                            }}
                          >
                            <svg className="caret" viewBox="0 0 10 6" aria-hidden="true">
                              <path d="M1 1l4 4 4-4" />
                            </svg>
                            {s.name}
                            {dice(
                              s.drills,
                              `${g.name} › ${s.name}`,
                              `drill-random-${slug(g.name)}-${slug(s.name)}`,
                            )}
                          </div>
                          {sOpen && <div role="group">{s.drills.map((d) => option(d, 3))}</div>}
                        </div>
                      );
                    })}
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
