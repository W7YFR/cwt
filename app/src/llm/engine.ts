/* The rag chew model (Step 3): WebLLM, on the GPU, in this tab. The model
 * downloads once from Hugging Face and the browser keeps it. What you send
 * never leaves the page. WebLLM itself loads only when the model is used.
 */

import type { AppConfig, MLCEngine } from "@mlc-ai/web-llm";
import { addHelper } from "@/devtools";
import { loadPrefs, savePrefs } from "@/io/storage";
import { micLog } from "@/micdebug";
import type { ChatTurn } from "@/qso/ragchew";

/** The model, and what it takes. Llama 3.1 8B did best (#240, #241).
 *
 * Each file is pinned: the weights, config and tokenizer at a Hugging Face
 * commit, and the model's code, its WebAssembly library, at a commit of MLC's
 * binary-mlc-llm-libs on GitHub. A commit's files never change. On top of
 * that, WebLLM checks the hash of the code, the config and the tokenizer
 * before it uses them, on every load, the browser's copy included, and stops
 * on a mismatch. The weights are numbers the code reads, not code. */
export const MODELS = {
  "Llama-3.1-8B-Instruct-q4f16_1-MLC": {
    label: "Llama 3.1 8B",
    /** What it is good for, in a sentence, for the choice between models. */
    note: "The best replies in our tests.",
    gb: 5,
    /** The computer's memory it needs, in GB: the graphics card of a laptop shares it. */
    memoryGb: 8,
    hf: "ac109a0e5f6dc3c2f4fbe02c20192f9f4665900d",
    lib: "Llama-3_1-8B-Instruct-q4f16_1_cs1k-webgpu.wasm",
    integrity: {
      model_lib: "sha256-32/8D3wwPUmypCZFfxj4I2Mrn+LQFMdkym9+mka1vy4=",
      config: "sha256-B06ZELdcsxiUJ0uaAwZvZY98FT5+NzdwxgIt6A+d5y0=",
      tokenizer: { "tokenizer.json": "sha256-u8GQTTUWnFQt/74fdYmlmU7HQm2eW2CdB7q4dvMul6s=" },
    },
  },
  "gemma-4-E2B-it-q4f16_1-MLC": {
    label: "Gemma 4 E2B",
    note: "Smaller and lighter, for a computer with less memory.",
    gb: 3,
    memoryGb: 6,
    hf: "633df598b7a473759367855273c63912c9e2bc9a",
    lib: "gemma-4-E2B-it-q4f16_1_cs512-webgpu.wasm",
    integrity: {
      model_lib: "sha256-bpzc6CPKKHIYQUbJtlDw3PzT+xFNecLjSvpMIPc85NI=",
      config: "sha256-ffrJa4/Mq3SfiI/Oz5VA46E45sfnLfJiPfKAplplgCU=",
      tokenizer: { "tokenizer.json": "sha256-zI06DONkZszBJ4v5h99fcdsXGbnKa0EYJk9Fy2J7/g8=" },
    },
  },
} as const;

/** The commit of binary-mlc-llm-libs the libraries come from, built for
 *  WebLLM 0.2.87 and later. */
const LIBS = "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/5b7251f3bdce957be2a7bf73a6f6c560d9874df4/web-llm-models/v0_2_87/base";
export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = "Llama-3.1-8B-Instruct-q4f16_1-MLC";

/** Where the model is. */
export type ModelState =
  | { readonly kind: "checking" }
  | { readonly kind: "no-gpu" }
  | { readonly kind: "absent" }
  | { readonly kind: "downloaded" }
  | {
      readonly kind: "loading";
      /** Downloading from Hugging Face, or loading from this computer onto the GPU. */
      readonly stage: "download" | "load";
      readonly progress: number;
      /** For a download: the MB fetched so far. */
      readonly mb: number | null;
      readonly text: string;
    }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly why: Failure; readonly error: string };

/** Why the model did not download or load: no room on disk, a graphics card
 *  without the memory for it, a download cut off, files that did not match
 *  their hashes, or anything else. */
export type Failure = "space" | "graphics" | "network" | "check" | "other";

/** The failure an error from WebLLM, the browser or the GPU stands for. */
export function failureOf(e: unknown): Failure {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  const text = `${name} ${e instanceof Error ? e.message : String(e)}`.toLowerCase();
  if (name === "QuotaExceededError" || /quota|no space|disk.*full|storage.*full/.test(text)) return "space";
  if (name === "IntegrityError" || /integrity/.test(text)) return "check";
  if (/out of memory|oom|device (was )?lost|devicelost|maxbuffersize|maxstoragebufferbindingsize|allocat/.test(text)) return "graphics";
  if (/failed to fetch|networkerror|network error|load failed|err_|aborted|timed? ?out/.test(text)) return "network";
  return "other";
}

/** The model chosen, kept across reloads. */
let model: ModelId = loadPrefs().qsoRagChewModel ?? DEFAULT_MODEL;
let state: ModelState = { kind: "checking" };
let engine: MLCEngine | null = null;
let loading: Promise<void> | null = null;
/** The engine while it loads, for `cancel`. */
let starting: MLCEngine | null = null;
/** `cancel` stopped the load under way: its failure is no failure. */
let cancelled = false;
const listeners = new Set<() => void>();

function set(next: ModelState): void {
  state = next;
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function modelState(): ModelState {
  return state;
}

export function modelId(): ModelId {
  return model;
}

const lib = () => import("@mlc-ai/web-llm");

/** WebLLM's own list of models, with ours pinned in place of its own. */
async function pinned(): Promise<AppConfig> {
  const { prebuiltAppConfig } = await lib();
  const ours = Object.entries(MODELS).map(([id, m]) => {
    const base = prebuiltAppConfig.model_list.find((r) => r.model_id === id);
    if (!base) throw new Error(`WebLLM has no ${id}`);
    return {
      ...base,
      model: `https://huggingface.co/mlc-ai/${id}/resolve/${m.hf}/`,
      model_lib: `${LIBS}/${m.lib}`,
      integrity: { ...m.integrity, tokenizer: { ...m.integrity.tokenizer }, onFailure: "error" as const },
    };
  });
  return { ...prebuiltAppConfig, model_list: ours };
}

/** Whether this browser has a GPU the model can use. */
async function gpuOk(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) return false;
  const adapter = await gpu.requestAdapter().catch(() => null);
  return !!adapter && adapter.features.has("shader-f16");
}

/** Look for the model: no GPU, not downloaded, or downloaded. */
export async function check(): Promise<void> {
  if (engine || loading) return;
  if (!(await gpuOk())) return set({ kind: "no-gpu" });
  const { hasModelInCache, deleteModelAllInfoInCache } = await lib();
  // A copy from before the pins, kept under WebLLM's own addresses, is never
  // used again: let its 5 GB go.
  if (await hasModelInCache(model).catch(() => false)) await deleteModelAllInfoInCache(model).catch(() => {});
  set({ kind: (await hasModelInCache(model, await pinned()).catch(() => false)) ? "downloaded" : "absent" });
}

/** Download the model if need be, and load it onto the GPU. */
export function load(): Promise<void> {
  if (engine) return Promise.resolve();
  loading ??= (async () => {
    // Not on this computer: it downloads first, until WebLLM says it loads.
    const first = state.kind === "downloaded" ? "load" : "download";
    set({ kind: "loading", stage: first, progress: 0, mb: null, text: "Starting" });
    cancelled = false;
    try {
      const { MLCEngine } = await lib();
      // Made first and kept, so `cancel` can stop it while it loads.
      starting = new MLCEngine({
        appConfig: await pinned(),
        initProgressCallback: (p) => {
          if (!cancelled) set(progressOf(p.progress, p.text, first));
        },
      });
      await starting.reload(model);
      engine = starting;
      set({ kind: "ready" });
    } catch (e) {
      engine = null;
      if (!cancelled) set({ kind: "failed", why: failureOf(e), error: e instanceof Error ? e.message : String(e) });
    } finally {
      starting = null;
      loading = null;
    }
  })();
  return loading;
}

/** With rag chew on: look for the model, and load it if it is downloaded.
 *  Never starts a download. */
export async function wake(): Promise<void> {
  if (engine || loading) return;
  if (state.kind === "checking") await check();
  if (state.kind === "downloaded") await load();
}

/** Stop a download under way, and delete what came of it, so nothing is left
 *  half on disk. */
export async function cancel(): Promise<void> {
  if (!starting) return;
  cancelled = true;
  await starting.unload().catch(() => {});
  await loading?.catch(() => {});
  const { deleteModelAllInfoInCache } = await lib();
  await deleteModelAllInfoInCache(model, await pinned()).catch(() => {});
  await sweep(model);
  set({ kind: "absent" });
}

/** Every file of model `id` the browser holds, gone: WebLLM fetches several
 *  parts at once, and one in flight when a download stops can land after
 *  WebLLM's own delete. */
async function sweep(id: ModelId): Promise<void> {
  const prefix = `https://huggingface.co/mlc-ai/${id}/`;
  try {
    for (const name of await caches.keys()) {
      if (!name.startsWith("webllm/")) continue;
      const cache = await caches.open(name);
      for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req);
    }
  } catch {
    /* no Cache API here: WebLLM's delete is all there is */
  }
}

/** Switch to `id`. The one in use leaves the GPU, and stays downloaded. */
export async function choose(id: ModelId): Promise<void> {
  if (id === model) return;
  await loading?.catch(() => {});
  await engine?.unload();
  engine = null;
  model = id;
  savePrefs({ ...loadPrefs(), qsoRagChewModel: id });
  set({ kind: "checking" });
  await check();
}

/** The models on this computer. */
export async function downloaded(): Promise<ModelId[]> {
  const { hasModelInCache } = await lib();
  const config = await pinned();
  const ids = Object.keys(MODELS) as ModelId[];
  const here = await Promise.all(ids.map((id) => hasModelInCache(id, config).catch(() => false)));
  return ids.filter((_, i) => here[i]);
}

/** WebLLM's progress as a state: "Fetching param cache[3/108]: 150MB
 *  fetched. 2% completed…" while it downloads, "Loading model from cache…" or
 *  "Loading GPU shader modules…" while it loads. */
export function progressOf(progress: number, text: string, first: "download" | "load"): ModelState {
  const mb = text.match(/(\d+)MB fetched/);
  return {
    kind: "loading",
    stage: text.startsWith("Fetching param cache") ? "download" : text.startsWith("Loading") ? "load" : first,
    progress,
    mb: mb ? Number(mb[1]) : null,
    text,
  };
}

/** Take a model out of the browser's storage, and off the GPU if it is the
 *  one in use. */
export async function remove(id: ModelId = model): Promise<void> {
  if (id === model) {
    await loading?.catch(() => {});
    await engine?.unload();
    engine = null;
  }
  const { deleteModelAllInfoInCache } = await lib();
  await deleteModelAllInfoInCache(id, await pinned()).catch(() => {});
  await sweep(id);
  if (id === model) set({ kind: "absent" });
  else set(state);
}

/** The station's reply in English, or null with no model loaded or on an
 *  error. */
export async function chat(system: string, turns: readonly ChatTurn[]): Promise<string | null> {
  if (!engine) return null;
  try {
    const out = await engine.chat.completions.create({
      messages: [{ role: "system", content: system }, ...turns],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 100,
    });
    return out.choices[0]?.message.content ?? null;
  } catch {
    return null;
  }
}

/** Where `__cwt.debugLLM(true)` is kept, so it lasts across reloads. */
const DEBUG_KEY = "cwt:debugLLM";

/** Whether rag chew lines go to the console. `?micdebug` is too busy to
 *  read them in. */
function debugOn(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

/** One rag chew event: into the mic transcript, and to the console with
 *  `__cwt.debugLLM(true)`. */
export function llmLog(event: string, detail: unknown): void {
  micLog(event, detail);
  if (debugOn()) console.info(`[llm] ${event}`, detail);
}

addHelper(
  "debugLLM",
  "debugLLM(true) prints each rag chew line to the console, kept across reloads: what you sent, the model's reply and " +
    "the CW sent. debugLLM(false) turns it off.",
  (on = true) => {
    try {
      if (on) localStorage.setItem(DEBUG_KEY, "1");
      else localStorage.removeItem(DEBUG_KEY);
    } catch {
      /* no local storage: nothing changes */
    }
    return on ? "LLM debug on, across reloads." : "LLM debug off.";
  },
);
