/* The rag chew setting on the QSO page.
 *
 * Until you accept the terms and the model is on this computer, the setting
 * is one button, Enable LLM ragchew. It opens a dialog that says what the
 * rag chew is, that it downloads the model from Hugging Face, and that a
 * model writes the station's lines. Accepting the terms there starts the
 * download and turns the rag chew on. After that the setting is a check, to
 * turn the rag chew on and off, with a trash can that deletes the model. */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { APP_VERSION } from "@/build-info";
import { check, load, modelId, MODELS, modelState, remove, subscribe, type Failure, type ModelState } from "@/llm/engine";
import { agree, agreed } from "@/terms";
import { ActionGroup, Check } from "./Controls";
import { TrashIcon } from "./Scores";

/** The model's state, as it changes. */
export function useModel(): ModelState {
  return useSyncExternalStore(subscribe, modelState);
}

const ABOUT =
  "After you and the station trade reports, names and QTHs, a model on this computer writes " +
  "the station's lines. The station chats about its rig, antenna and weather, and answers what " +
  "you send, until you send 73 or SK. What you send stays on this computer.";

/** The setting's help: what rag chew does, and where the model is. */
function help(s: ModelState, label: string, gb: number): string {
  const about = `${ABOUT} The model is ${label}, a one-time download of about ${gb} GB.`;
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
      return `${about} ${failureText(s.why, label, gb)} What the browser said: ${s.error}`;
  }
}

/** What went wrong with the download or the load, and what to do. */
function failureText(why: Failure, label: string, gb: number): string {
  switch (why) {
    case "space":
      return `There isn't enough free space on this computer for ${label}. Free up about ${Math.ceil(gb + 1)} GB, then try again.`;
    case "graphics":
      return `This computer's graphics card doesn't have enough memory for ${label}. The rag chew can't run on this computer.`;
    case "network":
      return `The download of ${label} stopped. Check your connection, then try again.`;
    case "check":
      return `${label}'s files didn't match the ones the rag chew was tested with. Try again later.`;
    case "other":
      return `${label} didn't load. Try again. If it fails again, delete the model and enable the rag chew again.`;
  }
}

export function RagChewGroup({ on, onChange }: { on: boolean; onChange(on: boolean): void }): React.ReactElement {
  const s = useModel();
  const { label, gb } = MODELS[modelId()];
  const [accepted, setAccepted] = useState(agreed);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    void check();
  }, []);
  // On, accepted and downloaded: onto the GPU, which takes a few seconds.
  useEffect(() => {
    if (on && accepted && s.kind === "downloaded") void load();
  }, [on, accepted, s.kind]);
  const here = s.kind === "downloaded" || s.kind === "loading" || s.kind === "ready";
  const failed = s.kind === "failed" && on;
  const dialog = asking && (
    <TermsDialog
      label={label}
      gb={gb}
      download={!here}
      onCancel={() => setAsking(false)}
      onAccept={() => {
        agree(APP_VERSION);
        setAccepted(true);
        setAsking(false);
        onChange(true);
        void load();
      }}
    />
  );

  if (!accepted || !(here || failed)) {
    return (
      <>
        <ActionGroup help={s.kind === "no-gpu" ? `${ABOUT} This browser can't run the model. It needs a browser that lets a page use the graphics card (WebGPU).` : help(s, label, gb)}>
          <button type="button" data-testid="qso-rag-chew-enable" disabled={s.kind === "no-gpu"} onClick={() => setAsking(true)}>
            Enable LLM ragchew
          </button>
        </ActionGroup>
        {dialog}
      </>
    );
  }
  return (
    <>
      <Check
        id="qso-rag-chew-on"
        label="Rag chew after the exchange"
        help={help(s, label, gb)}
        checked={on}
        action={
          (s.kind === "downloaded" || s.kind === "ready" || s.kind === "failed") && (
            <button
              type="button"
              className="iconbtn droprun"
              data-testid="qso-rag-chew-remove"
              aria-label={`Delete ${label}`}
              title={`Delete ${label} from this computer. Rag chew turns off. Enabling it again downloads ${label} again, about ${gb} GB.`}
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
        onChange={onChange}
      />
      {(s.kind === "loading" || failed) && (
        <div className="group" data-testid="qso-rag-chew" data-model={s.kind}>
          {s.kind === "failed" && (
            <p className="note" data-testid="qso-rag-chew-failed" data-why={s.why}>
              {failureText(s.why, label, gb)}
            </p>
          )}
          <div className="actionrow">
            {s.kind === "loading" ? (
              <button type="button" disabled>
                Loading {label}: {Math.round(s.progress * 100)}%
              </button>
            ) : (
              // A graphics card without the memory fails again: no retry.
              s.why !== "graphics" && (
                <button type="button" data-testid="qso-rag-chew-download" onClick={() => void load()}>
                  Try {label} again
                </button>
              )
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** A link out, in a new tab. */
function Out({ href, children }: { href: string; children: React.ReactNode }): React.ReactElement {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** What the rag chew is, the download, the terms, and a box to accept them.
 *  `download`: the model is not on this computer yet. */
function TermsDialog({
  label,
  gb,
  download,
  onCancel,
  onAccept,
}: {
  label: string;
  gb: number;
  download: boolean;
  onCancel(): void;
  onAccept(): void;
}): React.ReactElement {
  const [yes, setYes] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  /* On the body, over the Settings drawer. */
  return createPortal(
    <div
      className="sheet overdrawer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ragchew-terms-title"
        data-testid="qso-rag-chew-terms"
        data-own-escape=""
        tabIndex={-1}
        ref={box}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <h2 id="ragchew-terms-title">LLM ragchew</h2>
        <p>
          After the exchange of a plain QSO, the station keeps chatting with you about its rig, antenna and weather,
          and answers what you send, until you send 73 or SK.
        </p>
        <p>
          To do that, the rag chew uses a language model. That is a program that reads what you send, as text, and
          writes the station&rsquo;s reply. The page then sends the reply back to you as CW.
        </p>
        <p>
          {download ? (
            <>
              The model is <Out href={`https://huggingface.co/mlc-ai/${modelId()}`}>{label}</Out>. Enabling the rag
              chew downloads it, about {gb} GB, from <Out href="https://huggingface.co">Hugging Face</Out>, with a
              small program that runs it, from the{" "}
              <Out href="https://github.com/mlc-ai/binary-mlc-llm-libs">MLC project on GitHub</Out>.{" "}
            </>
          ) : (
            <>
              The model is <Out href={`https://huggingface.co/mlc-ai/${modelId()}`}>{label}</Out>, and it is already
              on this computer.{" "}
            </>
          )}
          The browser keeps the model on this computer until you remove it. The model runs on this computer&rsquo;s
          graphics card. What you send stays on this computer.
        </p>
        <p data-testid="qso-rag-chew-needs">
          It needs a browser that lets a page use the graphics card (WebGPU), about {MODELS[modelId()].memoryGb} GB of
          memory, and about {Math.ceil(gb + 1)} GB of free disk space.
        </p>
        <div className="caution">
          <p>
            <b>A language model writes the station&rsquo;s lines, not a person.</b> They can be wrong, made up or
            offensive. Do not rely on anything the station says.
          </p>
          <p>The author of CWT is not liable for anything the model says.</p>
        </div>
        {label.startsWith("Llama") ? (
          <p>
            {label} is under Meta&rsquo;s{" "}
            <a href="https://www.llama.com/llama3_1/license/" target="_blank" rel="noreferrer">
              Llama 3.1 Community License
            </a>{" "}
            and{" "}
            <a href="https://www.llama.com/llama3_1/use-policy/" target="_blank" rel="noreferrer">
              Acceptable Use Policy
            </a>
            .
          </p>
        ) : (
          <p>
            {label} is Google&rsquo;s, under the{" "}
            <Out href="https://www.apache.org/licenses/LICENSE-2.0">Apache 2.0 license</Out>.
          </p>
        )}
        <label className="check">
          <input
            type="checkbox"
            data-testid="qso-rag-chew-accept"
            checked={yes}
            onChange={(e) => setYes(e.target.checked)}
          />
          <span>
            I accept the{" "}
            <a href="terms.html">Terms</a>
            .
          </span>
        </label>
        <div className="confirm stack">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" data-testid="qso-rag-chew-yes" disabled={!yes} onClick={onAccept}>
            {download ? "Accept Terms and Download Model" : "Accept Terms and Turn On"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
