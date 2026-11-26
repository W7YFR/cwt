/* The debug panel, on every page, behind `__cwt.debug(true)` or `?debug`.
 *
 * With `?micdebug` on, the console scrolls with the microphone's transcript
 * several lines a second, and a rag chew line is gone before it can be read.
 * The panel puts what is worth watching on the screen instead: the debug
 * switches, the last rag chew lines, the Save buttons and the build. Each
 * switch is kept where its console helper keeps it, so the two always agree.
 *
 * A page gives the panel its own tools, the Save buttons and the microphone
 * readout, with `DebugTools`. They render in the page's tree, so they are as
 * current as the page, and show in the panel through a portal.
 *
 * Nothing renders without the switch, not even the hooks: see `MicDebug`.
 */

import { createContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { APP_VERSION } from "@/build-info";
import {
  debugPanelOn,
  livePageOn,
  onDebugPanel,
  onLivePage,
  onSuggestedReplies,
  setDebugPanel,
  setLivePage,
  setSuggestedReplies,
  suggestedRepliesOn,
} from "@/devtools";
import {
  MODELS,
  clearLlmEvents,
  llmDebugOn,
  llmEvents,
  modelId,
  modelState,
  onLlmDebug,
  onLlmEvents,
  setLlmDebug,
  subscribe as onModel,
  type LlmEvent,
  type ModelState,
} from "@/llm/engine";
import { micDebugOn, onMicDebug, setMicDebug } from "@/micdebug";
import { IconChevron } from "./Icons";

/** True inside the panel: the Save buttons show there without `?micdebug`. */
export const InDebugPanel = createContext(false);

/* Where a page's tools go: the panel's Save section while it is open. */
let slot: HTMLElement | null = null;
const slotListeners = new Set<() => void>();

function setSlot(el: HTMLElement | null): void {
  if (el === slot) return;
  slot = el;
  for (const l of slotListeners) l();
}

function onSlot(changed: () => void): () => void {
  slotListeners.add(changed);
  return () => slotListeners.delete(changed);
}

/** A page's own debug tools, shown in the panel's Save section while the
 *  panel is open, and nowhere otherwise. */
export function DebugTools({ children }: { children: ReactNode }): React.ReactElement | null {
  const el = useSyncExternalStore(onSlot, () => slot);
  return el ? createPortal(<InDebugPanel.Provider value>{children}</InDebugPanel.Provider>, el) : null;
}

/* Folded, and remembered across pages, as `MicDebug` is. */
let folded = false;

export function DebugPanel(): React.ReactElement | null {
  const on = useSyncExternalStore(onDebugPanel, debugPanelOn);
  return on ? <Panel /> : null;
}

/** One switch: its reader, setter and change event are its helper's own. */
interface Switch {
  readonly id: string;
  readonly label: string;
  readonly on: () => boolean;
  readonly set: (on: boolean) => void;
  readonly subscribe: (changed: () => void) => () => void;
  /** Set by the address, and so not turned off here. */
  readonly fixed?: () => boolean;
}

/** The switches, made when the panel shows, so a test that mocks a helper's
 *  module need not mock every export of it. */
const switches = (): readonly Switch[] => [
  {
    id: "micdebug",
    label: "Mic transcript to the console",
    on: micDebugOn,
    set: setMicDebug,
    subscribe: onMicDebug,
    fixed: () => new URLSearchParams(location.search).has("micdebug"),
  },
  { id: "debugllm", label: "Rag chew lines to the console", on: llmDebugOn, set: setLlmDebug, subscribe: onLlmDebug },
  {
    id: "replies",
    label: "Suggested replies in the QSO log",
    on: suggestedRepliesOn,
    set: setSuggestedReplies,
    subscribe: onSuggestedReplies,
  },
  { id: "live", label: "Live page", on: livePageOn, set: setLivePage, subscribe: onLivePage },
];

function Panel(): React.ReactElement {
  const [hidden, setHidden] = useState(folded);
  const fold = (next: boolean): void => {
    folded = next;
    setHidden(next);
  };

  if (hidden) {
    return (
      <button className="micdebug-tab debugtab" data-testid="debug-show" aria-label="Show the debug panel" onClick={() => fold(false)}>
        <IconChevron up /> debug
      </button>
    );
  }

  return (
    <div className="micdebug debugpanel" data-testid="debug-panel">
      <div className="bar">
        <span className="k">debug</span>
        <span className="debugbar">
          <button data-testid="debug-hide" aria-label="Fold the debug panel" onClick={() => fold(true)}>
            hide <IconChevron />
          </button>
          <button data-testid="debug-close" aria-label="Close the debug panel" onClick={() => setDebugPanel(false)}>
            close
          </button>
        </span>
      </div>
      <section>
        {switches().map((s) => (
          <SwitchRow key={s.id} s={s} />
        ))}
      </section>
      <RagChewLines />
      <section className="debugsave">
        <div className="k">save</div>
        <div className="debugtools" ref={setSlot} />
      </section>
      <Build />
    </div>
  );
}

function SwitchRow({ s }: { s: Switch }): React.ReactElement {
  const on = useSyncExternalStore(s.subscribe, s.on);
  return (
    <label className="check">
      <input type="checkbox" data-testid={`debug-switch-${s.id}`} checked={on} disabled={s.fixed?.() ?? false} onChange={(e) => s.set(e.target.checked)} />
      {s.label}
    </label>
  );
}

/** A field of an event's detail, as text, or "" when it has none. */
function field(detail: unknown, key: string): string {
  const v = (detail as Record<string, unknown> | null)?.[key];
  return v === undefined || v === null ? "" : String(v);
}

/** The last rag chew lines, newest last. */
function RagChewLines(): React.ReactElement {
  const events = useSyncExternalStore(onLlmEvents, llmEvents);
  return (
    <section data-testid="debug-ragchew" data-count={events.length}>
      <div className="bar">
        <span className="k">rag chew</span>
        <button data-testid="debug-ragchew-clear" disabled={events.length === 0} onClick={clearLlmEvents}>
          Clear
        </button>
      </div>
      {events.length === 0 && <div className="k">No rag chew lines yet.</div>}
      {events.map((e, i) => (
        <Event key={`${e.at}-${i}`} e={e} />
      ))}
    </section>
  );
}

function Event({ e }: { e: LlmEvent }): React.ReactElement {
  const { event, detail } = e;
  const why = field(detail, "why");
  const kept = event.startsWith("qso:") ? (why ? `not sent: ${why}` : "kept") : "";
  return (
    <div className="debugevent" data-testid="debug-event" data-event={event} data-why={why || undefined}>
      <div>
        <span className="k">{e.at.toFixed(1)}s </span>
        {event}
        {kept && <span className="k"> · {kept}</span>}
      </div>
      {event === "qso: rag chew" && <Line k="you said" v={field(detail, "said")} />}
      {event.startsWith("qso:") && <Line k="model" v={field(detail, "english")} />}
      {event.startsWith("qso:") && <Line k="cw" v={field(detail, "cw")} />}
      {event === "llm: error" && <Line k="error" v={`${field(detail, "name")}: ${field(detail, "message")}`} />}
      {event === "llm: cut off" && <Line k="cut off" v={`${field(detail, "maxTokens")} tokens: ${field(detail, "reply")}`} />}
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div>
      <span className="k">{k}: </span>
      {v || "(none)"}
    </div>
  );
}

/** The model's state in a few words. */
function stateWords(s: ModelState): string {
  if (s.kind === "loading") return `${s.stage} ${Math.round(s.progress * 100)}%`;
  if (s.kind === "failed") return `failed (${s.why})`;
  return s.kind;
}

function Build(): React.ReactElement {
  const state = useSyncExternalStore(onModel, modelState);
  return (
    <section data-testid="debug-build">
      <span className="k">build </span>v{APP_VERSION}
      <span className="k"> · model </span>
      {MODELS[modelId()].label} {stateWords(state)}
    </section>
  );
}
