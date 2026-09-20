/* What the browser actually says about the microphone, on a device with no
 * console.
 *
 * Safari's Web Inspector attaches over USB and shows nothing here, because the
 * app logs nothing — it is a quiet app and that is the right default. But the
 * microphone question is decided by three or four facts that live in different
 * places (a permission query that some browsers refuse to answer, a device
 * list that is sometimes withheld and sometimes anonymized, a secure context,
 * and what this page has already been granted once), and on a phone none of
 * them are reachable. Guessing which one is false is how the first fix for
 * this went wrong.
 *
 * So: the same facts, on the screen, behind `?micdebug`. A readout rather than
 * a log — the transcript of events is `micLog`'s job, in `@/micdebug`, under
 * the same flag — with a button to take the readings again after the
 * permission sheet has been answered. Nothing renders without the flag in the
 * URL, which is also why it can sit in the shipped bundle without being a
 * thing anyone trips over.
 */

import { useCallback, useEffect, useState } from "react";
import { APP_VERSION } from "@/build-info";
import { micDebugOn } from "@/micdebug";
import type { RecorderHandle } from "./useRecorder";
import { useMicAccess } from "./useMicAccess";

/** What `navigator.permissions` says, including *that it refused to say*.
 *
 * The distinction is the whole point. "unknown" in the rest of the app covers
 * two different browsers — one with no Permissions API and one that has it and
 * rejects this particular name — and which of those a phone is doing decides
 * whether the permission can be watched at all. */
type Probe = {
  secure: boolean;
  hasGetUserMedia: boolean;
  permissions: string;
  raw: { id: string; label: string }[];
};

async function probe(): Promise<Probe> {
  let permissions = "no navigator.permissions";
  const perms = navigator.permissions;
  if (perms?.query) {
    try {
      const status = await perms.query({ name: "microphone" as PermissionName });
      permissions = `query → "${status.state}"`;
    } catch (e) {
      const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      permissions = `query rejected (${err})`;
    }
  }
  let raw: { id: string; label: string }[] = [];
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    raw = devices
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({
        // Empty is the fact worth seeing, so it is spelled rather than shown
        // as a gap — and the id is truncated because it is a 64-character hash
        // and only its presence or absence means anything here.
        id: d.deviceId ? `${d.deviceId.slice(0, 8)}…` : "(empty)",
        label: d.label || "(empty)",
      }));
  } catch (e) {
    raw = [{ id: "(threw)", label: e instanceof Error ? e.message : String(e) }];
  }
  return {
    secure: window.isSecureContext,
    hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
    permissions,
    raw,
  };
}

/* Collapsed, and remembered across screens.
 *
 * Module-level for the same reason the grant is: each screen builds its own
 * panel, and one of them is mounted at a time. Folded away on the landing page
 * and then reopening itself on the review screen would be a control that does
 * not stay where it was put. No subscription needed, unlike the grant — the
 * only reader is the next mount. */
let folded = false;

function Row({ k, v }: { k: string; v: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <span className="k">{k}: </span>
      {v}
    </div>
  );
}

export function MicDebug({ rec }: { rec: RecorderHandle }): React.ReactElement | null {
  const access = useMicAccess();
  const [p, setP] = useState<Probe | null>(null);
  const [n, setN] = useState(0);
  const [hidden, setHidden] = useState(folded);

  const fold = (next: boolean): void => {
    folded = next;
    setHidden(next);
  };

  const take = useCallback(() => {
    void probe().then(setP);
  }, []);
  /* Nothing at all when the flag is absent — not even the reading. A panel
     that is not on screen enumerating devices is a side effect nobody asked
     for, and in the tests it is an async state update landing after the test
     that mounted it has finished. The early return below cannot prevent it:
     the hooks above it run either way, which is the rule. */
  useEffect(() => {
    if (!micDebugOn()) return;
    take();
  }, [take]);

  if (!micDebugOn()) return null;

  if (hidden) {
    return (
      <button
        className="micdebug-tab"
        data-testid="mic-debug-show"
        aria-label="Show the microphone readout"
        onClick={() => fold(false)}
      >
        {/* The one value worth carrying while folded: which branch the screen
            is in. It is the whole question the panel exists to answer, and
            seeing it change is often the entire check. */}
        mic ▴ needAccess={String(rec.needAccess)}
      </button>
    );
  }

  return (
    <div className="micdebug" data-testid="mic-debug">
      <div className="bar">
        <span className="k">microphone readout</span>
        <button
          data-testid="mic-debug-hide"
          aria-label="Hide the microphone readout"
          onClick={() => fold(true)}
        >
          hide ▾
        </button>
      </div>
      <Row k="build" v={`v${APP_VERSION}`} />
      <Row k="secure ctx" v={String(p?.secure)} />
      <Row k="getUserMedia" v={String(p?.hasGetUserMedia)} />
      <Row k="permissions" v={p?.permissions ?? "…"} />
      <Row k="useMicAccess" v={access} />
      <Row
        k="recorder"
        v={`probing=${rec.probing} needAccess=${rec.needAccess} blocked=${rec.blocked} recording=${Boolean(
          rec.recorder,
        )}`}
      />
      <Row
        k="devices"
        v={`${rec.devices.length} — ${rec.devices.map((d) => d.label).join(" | ") || "none"}`}
      />
      <div className="k">raw audioinput (re-read {n}×):</div>
      {(p?.raw ?? []).map((d, i) => (
        <div key={i}>
          {"  "}
          {d.id} {d.label}
        </div>
      ))}
      {p?.raw.length === 0 && <div>{"  (list is empty)"}</div>}
      <button
        className="reread"
        data-testid="mic-debug-reread"
        onClick={() => {
          setN((x) => x + 1);
          take();
        }}
      >
        re-read
      </button>
    </div>
  );
}
