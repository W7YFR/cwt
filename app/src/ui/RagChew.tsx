/* The rag chew setting on the QSO page: on or off, and the model behind it,
 * with its download. */

import { useEffect, useState, useSyncExternalStore } from "react";
import { check, load, modelId, MODELS, modelState, remove, subscribe, type ModelState } from "@/llm/engine";
import { Check } from "./Controls";
import { TrashIcon } from "./Scores";

/** The model's state, as it changes. */
export function useModel(): ModelState {
  return useSyncExternalStore(subscribe, modelState);
}

/** The setting's help: what rag chew does, and where the model is. */
function help(s: ModelState, label: string, gb: number): string {
  const about =
    "After you and the station trade reports, names and QTHs, a model on this computer writes " +
    "the station's lines. The station chats about its rig, antenna and weather, and answers what " +
    `you send, until you send 73 or SK. The model is ${label}, a one-time download of about ${gb} GB. ` +
    "What you send stays on this computer.";
  switch (s.kind) {
    case "checking":
    case "no-gpu":
      return about;
    case "absent":
      return `${about} ${label} is not downloaded yet.`;
    case "downloaded":
      return `${about} ${label} is downloaded. It loads when rag chew is on.`;
    case "loading":
      return `${about} ${label} is loading. The first time, this is the download.`;
    case "ready":
      return `${about} ${label} is loaded and ready.`;
    case "failed":
      return `${about} ${label} didn't load: ${s.error}`;
  }
}

export function RagChewGroup({ on, onChange }: { on: boolean; onChange(on: boolean): void }): React.ReactElement {
  const s = useModel();
  const { label, gb } = MODELS[modelId()];
  /** Checked with no model: the download waits for a yes. */
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    void check();
  }, []);
  // On, and downloaded: onto the GPU, which takes a few seconds.
  useEffect(() => {
    if (on && s.kind === "downloaded") void load();
  }, [on, s.kind]);
  const absent = s.kind === "absent" || s.kind === "failed";
  const toggle = (next: boolean) => {
    setAsking(next && absent);
    if (!next || !absent) onChange(next);
  };
  return (
    <>
      <Check
        id="qso-rag-chew-on"
        label="Rag chew after the exchange"
        help={help(s, label, gb)}
        checked={on}
        barred={s.kind === "no-gpu" ? "This browser can't run the model." : null}
        action={
          (s.kind === "downloaded" || s.kind === "ready") && (
            <button
              type="button"
              className="iconbtn droprun"
              data-testid="qso-rag-chew-remove"
              aria-label={`Delete ${label}`}
              title={`Delete ${label} from this computer. Rag chew turns off. Checking it again downloads ${label} again, about ${gb} GB.`}
              onClick={() => {
                // With no model, rag chew cannot be on.
                onChange(false);
                void remove();
              }}
            >
              <TrashIcon />
            </button>
          )
        }
        onChange={toggle}
      />
      {asking && absent ? (
        <div className="group" data-testid="qso-rag-chew-ask">
          <p className="note">
            Rag chew needs {label}, a one-time download of about {gb} GB. The browser keeps it on this computer.
          </p>
          <div className="actionrow">
            <button
              type="button"
              data-testid="qso-rag-chew-yes"
              onClick={() => {
                setAsking(false);
                onChange(true);
                void load();
              }}
            >
              Download {label}
            </button>
            <button type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        (absent || s.kind === "loading") && (
          <div className="group" data-testid="qso-rag-chew" data-model={s.kind}>
            <div className="actionrow">
              {s.kind === "loading" ? (
                <button type="button" disabled>
                  Loading {label}: {Math.round(s.progress * 100)}%
                </button>
              ) : (
                <button type="button" data-testid="qso-rag-chew-download" onClick={() => void load()}>
                  {s.kind === "failed" ? `Try ${label} again` : `Download ${label} (${gb} GB)`}
                </button>
              )}
            </div>
          </div>
        )
      )}
    </>
  );
}
