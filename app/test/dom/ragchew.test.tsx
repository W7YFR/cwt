/* The rag chew setting on the QSO page: Enable, the terms dialog, the choice
 * of model, and deleting a model. The engine is a fake that holds which
 * models are downloaded, so nothing downloads and no GPU is needed.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Id = "Llama-3.1-8B-Instruct-q4f16_1-MLC" | "gemma-4-E2B-it-q4f16_1-MLC";
const LLAMA: Id = "Llama-3.1-8B-Instruct-q4f16_1-MLC";
const GEMMA: Id = "gemma-4-E2B-it-q4f16_1-MLC";

const fake = vi.hoisted(() => ({
  here: new Set<string>(),
  model: "Llama-3.1-8B-Instruct-q4f16_1-MLC" as string,
  state: { kind: "absent" } as { kind: string; [k: string]: unknown },
  listeners: new Set<() => void>(),
  set(next: { kind: string; [k: string]: unknown }) {
    fake.state = next;
    for (const l of fake.listeners) l();
  },
}));

vi.mock("@/llm/engine", async (real) => {
  const { MODELS } = await real<typeof import("@/llm/engine")>();
  const look = () => fake.set({ kind: fake.here.has(fake.model) ? "downloaded" : "absent" });
  return {
    MODELS,
    subscribe: (l: () => void) => {
      fake.listeners.add(l);
      return () => fake.listeners.delete(l);
    },
    modelState: () => fake.state,
    modelId: () => fake.model,
    check: async () => look(),
    downloaded: async () => Object.keys(MODELS).filter((m) => fake.here.has(m)),
    choose: async (id: string) => {
      fake.model = id;
      look();
    },
    load: vi.fn(async () => {
      if (fake.here.has(fake.model)) fake.set({ kind: "ready" });
      else fake.set({ kind: "loading", stage: "download", progress: 0, mb: 0, text: "" });
    }),
    cancel: async () => look(),
    remove: async (id: string) => {
      fake.here.delete(id);
      if (id === fake.model) look();
    },
  };
});

const { RagChewGroup } = await import("@/ui/RagChew");
const { SettingsForm } = await import("@/ui/Controls");
const { agreed } = await import("@/terms");

let on = false;
let hints = false;
function Harness({ initial }: { initial: boolean }) {
  const [value, setValue] = useState(initial);
  const [suggests, setSuggests] = useState(false);
  on = value;
  hints = suggests;
  return (
    <SettingsForm>
      <RagChewGroup on={value} onChange={setValue} hints={suggests} onHints={setSuggests} />
    </SettingsForm>
  );
}

const byId = (id: string) => screen.queryByTestId(id);
/** The choice's buttons, in order: None, Llama, Gemma. */
const choices = () => Array.from(byId("qso-rag-chew-choice")!.querySelectorAll("button"));
const pressed = () => choices().findIndex((b) => b.getAttribute("aria-pressed") === "true");
const settle = () => act(async () => {});
const click = async (el: Element | null) => {
  fireEvent.click(el!);
  await settle();
};

async function mount(initial = false) {
  render(<Harness initial={initial} />);
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  fake.here = new Set();
  fake.model = LLAMA;
  fake.state = { kind: "absent" };
});
afterEach(cleanup);

describe("the rag chew setting", () => {
  it("is Enable until the terms are accepted, and Accept waits for the box", async () => {
    await mount();
    expect(byId("qso-rag-chew-enable")).not.toBeNull();
    expect(byId("qso-rag-chew-choice")).toBeNull();
    await click(byId("qso-rag-chew-enable"));
    expect(byId("qso-rag-chew-terms")).not.toBeNull();
    expect(byId("qso-rag-chew-pick"), "a switch between the models").not.toBeNull();
    expect(byId("qso-rag-chew-yes")).toHaveProperty("disabled", true);
    await click(byId("qso-rag-chew-accept"));
    expect(byId("qso-rag-chew-yes")).toHaveProperty("disabled", false);
  });

  it("records the terms on Accept, turns on, and shows the download with a Cancel", async () => {
    await mount();
    await click(byId("qso-rag-chew-enable"));
    await click(byId("qso-rag-chew-accept"));
    await click(byId("qso-rag-chew-yes"));
    expect(agreed()).toBe(true);
    expect(on).toBe(true);
    expect(byId("qso-rag-chew-terms")).toBeNull();
    expect(byId("qso-rag-chew")?.dataset.stage).toBe("download");
    await click(byId("qso-rag-chew-cancel"));
    expect(on, "no model here: off").toBe(false);
    expect(byId("qso-rag-chew-enable")).not.toBeNull();
  });

  it("is one choice once a model is here: None turns it off, the model on", async () => {
    localStorage.setItem("cwt:terms", JSON.stringify({ terms: 1, app: "1.0.0", at: "2026-11-25T00:00:00.000Z" }));
    fake.here.add(LLAMA);
    await mount(true);
    expect(pressed()).toBe(1);
    await click(choices()[0]!);
    expect(on).toBe(false);
    expect(pressed()).toBe(0);
    await click(choices()[1]!);
    expect(on).toBe(true);
    expect(byId("qso-rag-chew-remove"), "one model here: a trash can").not.toBeNull();
  });

  it("offers the model's suggested reply only once a model is here, and only with the model on", async () => {
    await mount();
    expect(document.getElementById("qso-rag-chew-hints"), "no model here").toBeNull();
    cleanup();
    localStorage.setItem("cwt:terms", JSON.stringify({ terms: 1, app: "1.0.0", at: "2026-11-25T00:00:00.000Z" }));
    fake.here.add(LLAMA);
    await mount(true);
    const check = () => document.getElementById("qso-rag-chew-hints") as HTMLInputElement;
    expect(check().checked, "off at first").toBe(false);
    await click(check());
    expect(hints).toBe(true);
    await click(choices()[0]!);
    expect(check().disabled, "rag chew None").toBe(true);
  });

  it("asks for a model not here without the terms again, for that model alone", async () => {
    localStorage.setItem("cwt:terms", JSON.stringify({ terms: 1, app: "1.0.0", at: "2026-11-25T00:00:00.000Z" }));
    fake.here.add(LLAMA);
    await mount(true);
    await click(choices()[2]!);
    expect(byId("qso-rag-chew-terms")).not.toBeNull();
    expect(byId("qso-rag-chew-pick"), "no switch back to the model here").toBeNull();
    expect(byId("qso-rag-chew-accept"), "terms already accepted").toBeNull();
    expect(byId("qso-rag-chew-yes")).toHaveProperty("disabled", false);
    await click(byId("qso-rag-chew-yes"));
    expect(fake.model).toBe(GEMMA);
    expect(JSON.parse(localStorage.getItem("cwt:terms")!).at, "the first time kept").toBe("2026-11-25T00:00:00.000Z");
  });

  it("deletes either model or both from ⋯ with both here", async () => {
    localStorage.setItem("cwt:terms", JSON.stringify({ terms: 1, app: "1.0.0", at: "2026-11-25T00:00:00.000Z" }));
    fake.here.add(LLAMA).add(GEMMA);
    await mount(true);
    expect(byId("qso-rag-chew-remove")).toBeNull();
    await click(byId("qso-rag-chew-models"));
    await click(byId(`qso-rag-chew-delete-${LLAMA}`));
    expect(fake.here.has(LLAMA)).toBe(false);
    expect(fake.model, "moved to the one left").toBe(GEMMA);
    expect(on).toBe(true);
    await click(byId("qso-rag-chew-remove"));
    expect(fake.here.size).toBe(0);
    expect(on).toBe(false);
    expect(byId("qso-rag-chew-enable")).not.toBeNull();
  });
});
