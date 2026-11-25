/* The rag chew setting on the QSO page.
 *
 * Until you accept the terms and the model is on this computer, the setting
 * is one button, Enable LLM rag chew. It opens a dialog that says what the
 * rag chew is, that it downloads the model from Hugging Face, and that a
 * model writes the station's lines. Accepting the terms there starts the
 * download and turns the rag chew on. After that the setting is a check, to
 * turn the rag chew on and off, and a choice of model. Each model downloads
 * once and stays until you delete it: a trash can with one on this computer,
 * ⋯ with both, to delete either or both. */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { APP_VERSION } from "@/build-info";
import {
  cancel, check, choose, downloaded, load, modelId, MODELS, modelState, remove, subscribe, type Failure, type ModelId, type ModelState,
} from "@/llm/engine";
import { agree, agreed } from "@/terms";
import { ActionGroup, ChoiceGroup, TipButton } from "./Controls";
import { TrashIcon } from "./Scores";
import { DeleteItem, MoreMenu } from "./Toolbar";

const IDS = Object.keys(MODELS) as ModelId[];


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
  const id = modelId();
  const { label, gb } = MODELS[id];
  const [accepted, setAccepted] = useState(agreed);
  /** The model the terms dialog is open for, or null. */
  const [asking, setAsking] = useState<ModelId | null>(null);
  /** The models on this computer, as last looked. */
  const [here, setHere] = useState<readonly ModelId[]>([]);
  const look = () => void downloaded().then(setHere);
  useEffect(() => {
    void check();
  }, []);
  // Again as the model in use changes state: a download that ends, a delete.
  useEffect(look, [s.kind, id]);
  // On, accepted and downloaded: onto the GPU, which takes a few seconds.
  useEffect(() => {
    if (on && accepted && s.kind === "downloaded") void load();
  }, [on, accepted, s.kind]);
  const inUse = s.kind === "downloaded" || s.kind === "loading" || s.kind === "ready";
  /** The progress box, brought into view when the dialog closes on a yes,
   *  so the download that starts is seen. */
  const progress = useRef<HTMLDivElement | null>(null);
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (!reveal || !progress.current) return;
    const box = progress.current;
    // After the frame that lays it out, so the whole box comes into view.
    const frame = requestAnimationFrame(() => box.scrollIntoView({ block: "center" }));
    setReveal(false);
    return () => cancelAnimationFrame(frame);
  }, [reveal, s.kind]);
  const failed = s.kind === "failed" && on;

  /** Delete models. Deleting the one in use moves to the other, if it is
   *  here, or turns the rag chew off. */
  const drop = async (ids: readonly ModelId[]) => {
    for (const d of ids) await remove(d);
    const left = (await downloaded()).filter((d) => !ids.includes(d));
    setHere(left);
    if (ids.includes(id)) {
      if (left[0]) await choose(left[0]);
      else onChange(false);
    }
  };
  /** Cancel the download under way: back to the other model, if it is here,
   *  or the rag chew off. */
  const stop = async () => {
    await cancel();
    const left = await downloaded();
    setHere(left);
    if (left[0]) await choose(left[0]);
    else onChange(false);
  };
  /** A choice of model: one here is switched to and turns the rag chew on;
   *  one not here asks first, in a dialog for that model alone. */
  const pick = (next: ModelId) => {
    if (!here.includes(next)) return setAsking(next);
    onChange(true);
    void choose(next);
  };

  const dialog = asking && (
    <TermsDialog
      initial={asking}
      choosable={!(accepted && (inUse || failed))}
      here={here}
      onCancel={() => setAsking(null)}
      onAccept={(chosen) => {
        // Only a first yes is recorded, so the time stays the time you accepted.
        if (!agreed()) agree(APP_VERSION);
        setAccepted(true);
        setAsking(null);
        setReveal(true);
        onChange(true);
        void choose(chosen).then(() => load());
      }}
    />
  );

  if (!accepted || !(inUse || failed)) {
    return (
      <>
        <ActionGroup help={s.kind === "no-gpu" ? `${ABOUT} This browser can't run the model. It needs a browser that lets a page use the graphics card (WebGPU).` : help(s, label, gb)}>
          <button type="button" data-testid="qso-rag-chew-enable" disabled={s.kind === "no-gpu"} onClick={() => setAsking(id)}>
            Enable LLM rag chew
          </button>
        </ActionGroup>
        {dialog}
      </>
    );
  }
  const del =
    here.length > 1 ? (
      <MoreMenu label="Delete a model" testId="qso-rag-chew-models">
        {here.map((d) => (
          <DeleteItem key={d} label={`Delete ${MODELS[d].label}`} testId={`qso-rag-chew-delete-${d}`} onClick={() => void drop([d])} />
        ))}
        <DeleteItem label="Delete both" testId="qso-rag-chew-delete-both" onClick={() => void drop(here)} />
      </MoreMenu>
    ) : (
      here.length === 1 && (
        <TipButton
          className="iconbtn droprun"
          testId="qso-rag-chew-remove"
          label={`Delete ${MODELS[here[0]!].label}`}
          tip={`Delete ${MODELS[here[0]!].label} from this computer. Rag chew turns off. Enabling it again downloads it again, about ${MODELS[here[0]!].gb} GB.`}
          onClick={() => void drop(here)}
        >
          <TrashIcon />
        </TipButton>
      )
    );
  return (
    <>
      <ChoiceGroup
        id="qso-rag-chew-choice"
        label="Rag chew"
        help={help(s, label, gb)}
        value={on ? id : "none"}
        options={[{ value: "none", label: "None" }, ...IDS.map((m) => ({ value: m, label: MODELS[m].label }))]}
        action={del}
        onChange={(v) => (v === "none" ? onChange(false) : pick(v as ModelId))}
      />
      {s.kind === "loading" ? (
        <div className="group" data-testid="qso-rag-chew" data-model={s.kind} data-stage={s.stage} ref={progress}>
          <Progress s={s} label={label} onCancel={() => void stop()} />
        </div>
      ) : (
        failed && (
          <div className="group" data-testid="qso-rag-chew" data-model={s.kind}>
            <p className="note" data-testid="qso-rag-chew-failed" data-why={s.why}>
              {failureText(s.why, label, gb)}
            </p>
            {/* A graphics card without the memory fails again: no retry. */}
            {s.why !== "graphics" && (
              <div className="actionrow">
                <button type="button" data-testid="qso-rag-chew-download" onClick={() => void load()}>
                  Try {label} again
                </button>
              </div>
            )}
          </div>
        )
      )}
      {dialog}
    </>
  );
}

/** A size in MB, as MB or, from 1 GB, as GB. */
const size = (mb: number) => (mb < 1000 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`);

/** The download or the load, as a bar, with what it is and how far along. */
function Progress({
  s,
  label,
  onCancel,
}: {
  s: Extract<ModelState, { kind: "loading" }>;
  label: string;
  onCancel(): void;
}): React.ReactElement {
  const pct = Math.floor(s.progress * 100);
  // WebLLM tells progress as each part of the model comes, about 200 MB.
  const waiting = s.progress === 0;
  const sofar = s.stage === "download" && s.mb && s.progress > 0.005 ? ` · ${size(s.mb)} of ${size(s.mb / s.progress)}` : "";
  return (
    <div className="progressbox" role="status" aria-live="polite">
      <div className="progresshead">
        <b>{s.stage === "download" ? `Downloading ${label}` : `Loading ${label}`}</b>
        <span>{waiting ? "Starting" : `${pct}%${sofar}`}</span>
      </div>
      <div className="progressbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label} data-waiting={waiting}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {s.stage === "download" && (
        <div className="progressfoot">
          <button type="button" data-testid="qso-rag-chew-cancel" onClick={onCancel}>
            Cancel download
          </button>
        </div>
      )}
    </div>
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

/** Each model's version of a part of the dialog, all in one place and only
 *  the chosen one seen, so the dialog is as tall as the longest and does not
 *  change height when the choice does. */
function Stack({ chosen, part }: { chosen: ModelId; part(id: ModelId): React.ReactNode }): React.ReactElement {
  return (
    <div className="permodel">
      {IDS.map((m) => (
        <div key={m} data-on={m === chosen} aria-hidden={m !== chosen}>
          {part(m)}
        </div>
      ))}
    </div>
  );
}

/** What a model is good for (with the switch, `note`), what downloads, and
 *  what it needs. */
function ModelText({ id, here, note: withNote }: { id: ModelId; here: boolean; note: boolean }): React.ReactElement {
  const { label, gb, note, memoryGb } = MODELS[id];
  return (
    <>
      {withNote && <p className="note">{note}</p>}
      <p>
        {here ? (
          <>
            The model is <Out href={`https://huggingface.co/mlc-ai/${id}`}>{label}</Out>, and it is already on this
            computer.{" "}
          </>
        ) : (
          <>
            The model is <Out href={`https://huggingface.co/mlc-ai/${id}`}>{label}</Out>. Enabling the rag chew
            downloads it, about {gb} GB, from <Out href="https://huggingface.co">Hugging Face</Out>, with a small
            program that runs it, from the <Out href="https://github.com/mlc-ai/binary-mlc-llm-libs">MLC project on GitHub</Out>.{" "}
          </>
        )}
        The browser keeps the model on this computer until you remove it. The model runs on this computer&rsquo;s
        graphics card. What you send stays on this computer.
      </p>
      <p data-testid="qso-rag-chew-needs">
        It needs a browser that lets a page use the graphics card (WebGPU), about {memoryGb} GB of memory, and about{" "}
        {Math.ceil(gb + 1)} GB of free disk space.
      </p>
    </>
  );
}

/** A model's license. */
function License({ id }: { id: ModelId }): React.ReactElement {
  const { label } = MODELS[id];
  return label.startsWith("Llama") ? (
    <p>
      {label} is under Meta&rsquo;s{" "}
      <Out href="https://www.llama.com/llama3_1/license/">Llama 3.1 Community License</Out> and{" "}
      <Out href="https://www.llama.com/llama3_1/use-policy/">Acceptable Use Policy</Out>.
    </p>
  ) : (
    <p>
      {label} is Google&rsquo;s, under the <Out href="https://www.apache.org/licenses/LICENSE-2.0">Apache 2.0 license</Out>.
    </p>
  );
}

/** What the rag chew is, a choice of model, what downloads, the terms, and a
 *  box to accept them. Opens at `initial`. `here`: the models already on
 *  this computer. */
function TermsDialog({
  initial,
  choosable,
  here,
  onCancel,
  onAccept,
}: {
  initial: ModelId;
  /** Opened from Enable: a switch between the models. Opened by choosing a
   *  model: that model alone. */
  choosable: boolean;
  here: readonly ModelId[];
  onCancel(): void;
  onAccept(chosen: ModelId): void;
}): React.ReactElement {
  const [chosen, setChosen] = useState(initial);
  const download = !here.includes(chosen);
  // Accepted before, for the other model: no terms to accept again.
  const [accepted] = useState(agreed);
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
        <h2 id="ragchew-terms-title">LLM Rag Chew</h2>
        <p>
          After the exchange of a plain QSO, the station keeps chatting with you about its rig, antenna and weather,
          and answers what you send, until you send 73 or SK.
        </p>
        <p>
          To do that, the rag chew uses a language model. That is a program that reads what you send, as text, and
          writes the station&rsquo;s reply. The page then sends the reply back to you as CW.
        </p>
        {choosable && (
          <div className="pick" data-testid="qso-rag-chew-pick">
            <div className="modeswitch" role="group" aria-label="Model">
              {IDS.map((m) => (
                <button key={m} type="button" aria-pressed={chosen === m} onClick={() => setChosen(m)}>
                  {MODELS[m].label}
                </button>
              ))}
            </div>
          </div>
        )}
        <Stack chosen={chosen} part={(m) => <ModelText id={m} here={here.includes(m)} note={choosable} />} />
        <div className="caution">
          <p>
            <b>A language model writes the station&rsquo;s lines, not a person.</b> They can be wrong, made up or
            offensive. Do not rely on anything the station says.
          </p>
          <p>The author of CWT is not liable for anything the model says.</p>
        </div>
        <Stack chosen={chosen} part={(m) => <License id={m} />} />
        {!accepted && (
          <label className="check">
            <input
              type="checkbox"
              data-testid="qso-rag-chew-accept"
              checked={yes}
              onChange={(e) => setYes(e.target.checked)}
            />
            <span>
              I accept the <a href="terms.html">Terms</a>.
            </span>
          </label>
        )}
        <div className="confirm stack">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" data-testid="qso-rag-chew-yes" disabled={!accepted && !yes} onClick={() => onAccept(chosen)}>
            {accepted ? (download ? "Download Model" : "Turn On") : download ? "Accept Terms and Download Model" : "Accept Terms and Turn On"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
