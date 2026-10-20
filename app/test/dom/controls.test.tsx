/* The control row, against a real DOM.
 *
 * These are about wiring and about the constraints between controls — the
 * things that are invisible in a screenshot and obvious the moment they break.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  ChartSettingsButton,
  ChartSettingsPanel,
  Controls,
  ViewControls,
} from "@/ui/Controls";
import { defaultSettings, TIMES_MAX, TIMES_MIN } from "@/timing";
import { PACE_LEAD_MAX_SEC } from "@/render/geometry";
import { BREAK_MAX_SEC } from "@/timing/timeline";
import type { ReviewSettings } from "@/types";
import type { Profile } from "@/io/profiles";
import type { AudioSetup } from "@/ui/Controls";
import { caseNamed, SLOPPY } from "../fixture";
import { takeFrom } from "../fixture";

function Harness({
  initial,
  onSettings,
  fromFile,
}: {
  initial?: Partial<ReviewSettings>;
  onSettings?: (s: ReviewSettings) => void;
  /** This session was opened from a file rather than keyed. */
  fromFile?: boolean;
}) {
  const take = takeFrom(caseNamed(SLOPPY));
  const [settings, setSettings] = useState<ReviewSettings>({
    ...defaultSettings(take),
    ...initial,
  });
  return (
    <Controls
      settings={settings}
      onChange={(patch) =>
        setSettings((prev) => {
          const next = { ...prev, ...patch };
          // Mirrors the clamp useTake applies, so the harness cannot pass a
          // pair of speeds the real app would never produce.
          if (next.farnsworthWpm > next.charWpm) next.farnsworthWpm = next.charWpm;
          onSettings?.(next);
          return next;
        })
      }
      fromFile={fromFile === true}
    />
  );
}

const defaults = () => defaultSettings(takeFrom(caseNamed(SLOPPY)));

/** The pair, as the page has them: the chart's own controls, and the way into
 *  everything else on the row above. Used for rerenders, where the panel's
 *  open state has to survive — so the same two components in the same two
 *  places, every time. */
function view(over: Partial<ReviewSettings>, onChange: (p: Partial<ReviewSettings>) => void) {
  const settings = { ...defaults(), ...over };
  return (
    <>
      <ViewControls runs={1} settings={settings} onChange={onChange} onFit={() => {}} />
      <Panelled runs={1} settings={settings} onChange={onChange} />
    </>
  );
}

/** The button and the band it opens, wired together the way the page wires
 *  them — the button lives in the header corner and the band under it, with
 *  the open state between them. */
function Panelled(props: {
  settings: ReviewSettings;
  onChange(patch: Partial<ReviewSettings>): void;
  runs: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ChartSettingsButton open={open} onToggle={() => setOpen((v) => !v)} />
      {open && <ChartSettingsPanel {...props} />}
    </>
  );
}

/* Most of these controls are behind the cog in the corner, so a test that
   wants one opens it first. */
function openPanel() {
  fireEvent.click(screen.getByTestId("panel-toggle"));
}

function renderView({
  over = {},
  onChange = () => {},
  runs = 1,
  open,
}: {
  over?: Partial<ReviewSettings>;
  onChange?: (p: Partial<ReviewSettings>) => void;
  runs?: number;
  open?: boolean;
} = {}) {
  const settings = { ...defaults(), ...over };
  /* Both, because the page has both: the chart's own controls in their row,
     and the way into everything else on the row above. They are two components
     for one question — what is on screen — and testing either alone would miss
     that the cog outlives the row it used to live on. */
  const rendered = render(
    <>
      <ViewControls
        runs={runs}
        settings={settings}
        onChange={onChange}
        onFit={() => {}}
      />
      <Panelled runs={runs} settings={settings} onChange={onChange} />
    </>,
  );
  if (open) openPanel();
  return rendered;
}

/** The view controls wired to real state, for the boxes whose behavior is in
 *  the round trip rather than in a single render. */
function renderStateful() {
  function Harnessed() {
    const [s, set] = useState<ReviewSettings>({ ...defaults(), paceCursor: true });
    const onChange = (patch: Partial<ReviewSettings>) =>
      set((prev) => ({ ...prev, ...patch }));
    return (
      <>
        <ViewControls runs={1} settings={s} onChange={onChange} onFit={() => {}} />
        <Panelled runs={1} settings={s} onChange={onChange} />
      </>
    );
  }
  render(<Harnessed />);
  openPanel();
  return () => byId("pace-lead") as HTMLInputElement;
}

/** A setting by its id: what it does may be reworded, its id stays. */
function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  return el;
}
const queryId = (id: string) => document.getElementById(id);

/** What a setting says about itself: its question mark's box, in the
 *  settings panels, or its tooltip elsewhere. */
function about(el: Element | null): string {
  if (!el) return "";
  const tip = el.querySelector(".helpdot")?.getAttribute("aria-describedby");
  if (tip) return document.getElementById(tip)?.textContent ?? "";
  return el.getAttribute("title") ?? "";
}

describe("controls", () => {
  it("shows every reading padded to a constant width", () => {
    // The whole reason for the padding: the groups are sized by their content
    // and the intended-message field absorbs the slack, so a reading that
    // gains a digit drags the row and wraps the caption beside it. Dragging a
    // slider made that twitch once; zooming with the wheel made it constant.
    const READOUTS = ["wpm-out", "farns-out", "tol-out"];
    const widthsFor = (container: HTMLElement) =>
      READOUTS.map((id) => container.querySelector(`#${id}`)!.textContent!.length);

    const narrow = render(
      <Harness initial={{ charWpm: 9, farnsworthWpm: 9, tolerance: 0.05, gainDb: 0 }} />,
    );
    const narrowWidths = widthsFor(narrow.container);
    // Checked before unmounting: the padding is real padding, not a
    // coincidence of two readings happening to have the same digit count.
    expect(narrow.container.textContent).toContain(" 9 wpm");
    narrow.unmount();

    const wide = render(
      <Harness
        initial={{ charWpm: 45, farnsworthWpm: 45, tolerance: 0.6, gainDb: 42, ppu: 18.5 }}
      />,
    );
    expect(widthsFor(wide.container)).toEqual(narrowWidths);
  });

  it("commits a repeat count, clamped to what can be built", () => {
    /* The field is held as text while it is being edited, so what is under
       test is what gets COMMITTED — typing past the ceiling has to settle at
       the ceiling rather than at whatever was typed. */
    const seen: ReviewSettings[] = [];
    render(<Harness onSettings={(s) => seen.push(s)} />);
    const times = document.getElementById("times") as HTMLInputElement;

    fireEvent.change(times, { target: { value: "3" } });
    expect(seen.at(-1)!.times).toBe(3);

    fireEvent.change(times, { target: { value: "999" } });
    expect(seen.at(-1)!.times).toBe(TIMES_MAX);

    fireEvent.change(times, { target: { value: "0" } });
    expect(seen.at(-1)!.times).toBe(TIMES_MIN);

    // And the message it repeats is untouched by any of it.
    expect(seen.at(-1)!.expected).toBe(seen[0]!.expected);
  });

  it("does not ask how many passes a file holds", () => {
    /* `times` says how many you are ABOUT to send, and a file was sent before
       the app saw it. The grading ignores it either way — this is the control
       saying so rather than sitting there apparently set to five. */
    const keyed = render(<Harness />);
    const offered = document.getElementById("times") as HTMLInputElement;
    expect(offered, "offered for a take you key").toBeEnabled();
    const keyedTitle = offered.closest("label")!.getAttribute("title");
    keyed.unmount();

    render(<Harness fromFile />);
    const times = document.getElementById("times") as HTMLInputElement;
    expect(times, "barred for one you opened").toBeDisabled();

    /* And it says why. A control barred for a reason has to be able to give
       the reason — the two states are different sentences, not the same one
       with the box greyed. */
    const barred = times.closest("label")!.getAttribute("title");
    expect(barred, "the barred field explains itself").toBeTruthy();
    expect(barred, "and not with the copy for a take you key").not.toBe(
      keyedTitle,
    );
    /* What it would grade as is the pure tier's question — `fireEvent.change`
       dispatches straight at the element, so a disabled input answers it here
       and would not in a browser. */
  });

  it("will not let the overall speed exceed the character speed", () => {
    const seen: ReviewSettings[] = [];
    render(<Harness initial={{ charWpm: 25, farnsworthWpm: 25 }} onSettings={(s) => seen.push(s)} />);

    const farns = document.getElementById("farns") as HTMLInputElement;
    // The slider's own ceiling follows the character speed, so the invalid
    // pair is unreachable rather than silently clamped after the fact.
    expect(farns.max).toBe("25");

    // A range input has no text to type into, so drive it the way a drag
    // does. fireEvent.change goes through React's value tracker; a raw
    // dispatch would be swallowed as a no-op change.
    fireEvent.change(document.getElementById("wpm")!, { target: { value: "12" } });

    expect(seen.at(-1)?.charWpm).toBe(12);
    expect(seen.at(-1)!.farnsworthWpm).toBeLessThanOrEqual(12);
  });

  it("upper-cases the intended message as you type", async () => {
    const user = userEvent.setup();
    const seen: ReviewSettings[] = [];
    render(<Harness onSettings={(s) => seen.push(s)} />);
    const box = screen.getByRole("textbox", { name: /Intended message/i });
    await user.clear(box);
    await user.type(box, "cq de w7yfr");
    expect(seen.at(-1)?.expected).toBe("CQ DE W7YFR");
  });

  it("clears the intended message from inside the box, and offers to only when there is something to clear", async () => {
    const user = userEvent.setup();
    const seen: ReviewSettings[] = [];
    render(<Harness initial={{ expected: "CQ DE W7YFR" }} onSettings={(s) => seen.push(s)} />);
    const box = screen.getByRole("textbox", { name: /Intended message/i }) as HTMLInputElement;

    await user.click(screen.getByTestId("clear-expected"));
    expect(seen.at(-1)?.expected).toBe("");
    // The caret lands where you would type the replacement, which is the
    // reason to reach for this rather than select-all and delete.
    expect(document.activeElement).toBe(box);
    // Nothing left to clear, so nothing offering to.
    expect(screen.queryByTestId("clear-expected")).toBeNull();
  });

  it("can take the control row away without taking the way back with it", async () => {
    /* Off is for when the chart is set the way you want it and the page should
       be nothing but chart. The cog cannot go with it: it is the switch that
       turned the row off, and a setting you cannot reach is one you cannot
       undo. */
    const ids = ["#run-sort", "#view", "#show-runs", "#zoom", "#zoom-fit"];
    const on = renderView({ runs: 3, open: true });
    for (const id of ids) expect(on.container.querySelector(id), id).not.toBeNull();
    on.unmount();

    const off = renderView({
      runs: 3,
      open: true,
      over: { showChartControls: false },
    });
    for (const id of ids) expect(off.container.querySelector(id), id).toBeNull();
    // The way back, and the switch itself.
    expect(screen.getByTestId("panel-toggle")).toBeTruthy();
    expect(byId("show-chart-controls")).toBeTruthy();
  });

  it("keeps the axis out and everything else behind the cog", async () => {
    /* Thirteen controls on one line wrapped into three and moved the ones you
       reach for constantly every time a conditional checkbox appeared. Zoom,
       the axis and the row order are adjusted while looking at the chart and
       stay out; everything else is set once and lives behind the cog. */
    const user = userEvent.setup();
    const { container } = renderView({ runs: 3 });
    // By id, because the labels carry their readings with them — "Zoom 10.4
    // px/unit" is one label, and matching on the word alone finds the slider
    // and the output both.
    for (const always of ["#view", "#zoom", "#run-sort"]) {
      expect(container.querySelector(always), always).not.toBeNull();
    }
    expect(queryId("collapse-rests")).toBeNull();
    expect(queryId("pace-absolute")).toBeNull();

    const cog = screen.getByTestId("panel-toggle");
    expect(cog.getAttribute("aria-pressed")).toBe("false");
    await user.click(cog);

    // Both bands at once: what is drawn, and what runs while you send.
    expect(cog.getAttribute("aria-pressed")).toBe("true");
    expect(byId("collapse-rests")).toBeTruthy();
    expect(byId("pace-absolute")).toBeTruthy();
    // And the axis never went anywhere.
    expect(container.querySelector("#view")).not.toBeNull();

    // The cog is the way back out as well as the way in.
    await user.click(cog);
    expect(queryId("collapse-rests")).toBeNull();
    expect(queryId("pace-absolute")).toBeNull();
  });

  it("groups each setting by the question it answers", async () => {
    const user = userEvent.setup();
    const { container } = renderView({ runs: 3 });
    await user.click(screen.getByTestId("panel-toggle"));

    const row = (name: string) => container.querySelector(`[data-panel='${name}']`)!;
    expect(row("target")).toContainElement(byId("break-sec"));
    expect(row("grading")).toContainElement(byId("ignore-construction"));
    // The three ways to record, together in a section of their own.
    for (const id of ["plain-follow", "plain-grading", "zen-progress", "zen-grading", "pace-absolute", "pace-lead"]) {
      expect(row("modes"), id).toContainElement(byId(id));
    }
    expect(row("display")).toContainElement(byId("collapse-rests"));
    expect(row("display")).toContainElement(byId("run-scores"));
    expect(row("audio")).toContainElement(container.querySelector<HTMLElement>("#gain"));
    expect(row("extras")).toContainElement(byId("advanced-grading"));
    for (const name of ["audio", "modes", "target", "grading", "display", "extras"]) {
      expect(row(name).querySelector(".uplabel")!.textContent, name).not.toBe("");
    }
  });

  it("pads the listening level to a constant width", () => {
    const width = (gainDb: number) => {
      const r = renderView({ open: true, over: { gainDb } });
      const n = r.container.querySelector("#gain-out")!.textContent!.length;
      r.unmount();
      return n;
    };
    expect(width(0)).toBe(width(42));
  });

  it("offers what to draw on a stack only when there is a stack", async () => {
    /* Both controls are about attempts side by side. With one on screen the
       scores would repeat the band under the chart and there is no "every row"
       to caption, so neither is a question worth putting in a row that already
       carries eight. */
    const user = userEvent.setup();
    const seen: Partial<ReviewSettings>[] = [];
    const { unmount } = renderView({ runs: 1 });
    expect(queryId("run-scores")).toBeNull();
    expect(queryId("caption-all")).toBeNull();
    unmount();

    renderView({ runs: 3, onChange: (p) => seen.push(p), open: true });
    await user.click(byId("run-scores"));
    await user.click(byId("caption-all"));
    // Defaults are scores on, one caption — so each click is the other way.
    expect(seen).toEqual([{ runScores: false }, { captionAll: true }]);
  });

  it("bars Sort where there is only one row to order, and says why", () => {
    /* One row has exactly one arrangement: a session with one attempt, or a
       session drawing only its last. Sort stays in place, barred. */
    const sort = () => screen.getByLabelText(/^sort$/i) as HTMLSelectElement;
    const why = () => sort().closest(".group")!.getAttribute("title") ?? "";

    const one = renderView({ runs: 1 });
    expect(sort()).toBeDisabled();
    expect(why()).toMatch(/more than one run/i);
    expect(screen.getByLabelText(/^show$/i)).toBeDisabled();
    one.unmount();

    const shrunk = renderView({ runs: 3, over: { showRuns: "last" } });
    expect(sort()).toBeDisabled();
    expect(why()).toMatch(/more than one run on the chart/i);
    // And Show stays live, or there would be no way back out of it.
    expect(screen.getByLabelText(/^show$/i)).toBeEnabled();
    shrunk.unmount();

    renderView({ runs: 3, over: { showRuns: "last3" } });
    expect(sort()).toBeEnabled();
  });

  it("puts whole blocks of the page on their own switches", async () => {
    /* None of these is about the chart — each puts a block on the page or
       takes it away — so they are a band of their own rather than more ways to
       draw marks. Two start on and one off: a hint nobody has seen cannot be
       asked for and the tables are the answer to "why", while getting a file
       out is an occasional act. */
    const user = userEvent.setup();
    const seen: Partial<ReviewSettings>[] = [];
    // A stack, so the two chart switches that need one are on show and the
    // count below is the whole band rather than part of it.
    const { container } = renderView({ runs: 3, open: true, onChange: (p) => seen.push(p) });
    const extras = container.querySelector("[data-panel='extras']")!;
    const chart = container.querySelector("[data-panel='display']")!;

    const boxes = [
      ["show-chart-controls", true, { showChartControls: false }],
      ["show-downloads", false, { showDownloads: true }],
      ["show-hints", true, { showHints: false }],
      ["advanced-grading", true, { advancedGrading: false }],
    ] as const;
    for (const [label, on, patch] of boxes) {
      const box = byId(label) as HTMLInputElement;
      expect(box.checked, String(label)).toBe(on);
      expect(extras, String(label)).toContainElement(box);
      await user.click(box);
      expect(seen.at(-1), String(label)).toEqual(patch);
    }

    // And the chart band keeps only the four that change how it is drawn.
    expect(chart.querySelectorAll("input[type='checkbox']")).toHaveLength(4);
  });

  it("offers grading spacing only, on to start", async () => {
    const user = userEvent.setup();
    const seen: Partial<ReviewSettings>[] = [];
    const { container } = renderView({ open: true, onChange: (p) => seen.push(p) });
    const box = byId("ignore-construction") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(container.querySelector("[data-panel='grading']")).toContainElement(box);
    await user.click(box);
    expect(seen.at(-1)).toEqual({ ignoreConstruction: false });
  });


  it("leaves playback to the chart", () => {
    const take = takeFrom(caseNamed(SLOPPY));
    render(<Controls settings={defaultSettings(take)} onChange={() => {}} fromFile={false} />);
    expect(screen.queryByRole("button", { name: /your sending/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^target$/i })).toBeNull();
    // Stop is on the chart, and Loop and the listening level are in Audio.
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /loop/i })).toBeNull();
    expect(queryId("gain")).toBeNull();
  });

  it("says what an empty intended message means, inside the box", () => {
    const take = takeFrom(caseNamed(SLOPPY));
    const common = {
      onChange: () => {},
      fromFile: false,
    } as const;
    const base = defaultSettings(take);
    const { rerender } = render(
      <Controls {...common} settings={{ ...base, expected: "" }} />,
    );
    const box = screen.getByRole("textbox", { name: /Intended message/i }) as HTMLInputElement;
    // Worth saying at all: with nothing here the accuracy figure is graded
    // against the decoder's own reading and reads as a tautology.
    expect(box.placeholder).not.toBe("");

    // And worth saying *here*: it lives and dies with the box's own contents,
    // so the label beside it is one fixed string. Text that came and went next
    // to the label had to wrap somewhere the label did not, and dropped out of
    // sight.
    const label = box.labels![0]!;
    const words = label.textContent;
    rerender(<Controls {...common} settings={{ ...base, expected: "CQ" }} />);
    expect(box.labels![0]!.textContent).toBe(words);
  });

  it("keeps what is graded apart from what is drawn", () => {
    /* The row used to hold nine controls, four of which changed the grade and
       three of which only changed the picture — indistinguishable from each
       other, and a zoom slider beside a tolerance slider implies they are the
       same sort of thing. The drawing controls live beside the drawing now. */
    const take = takeFrom(caseNamed(SLOPPY));
    const { container } = render(<Harness />);
    for (const id of ["view", "zoom", "zoom-fit"]) {
      expect(container.querySelector(`#${id}`)).toBeNull();
    }

    render(
      <ViewControls runs={1}
        settings={defaultSettings(take)}
        onChange={() => {}}
        onFit={() => {}}
      />,
    );
    for (const id of ["view", "zoom", "zoom-fit"]) {
      expect(document.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("offers characters without their elements, off unless asked for", async () => {
    /* What the trainer is for is spacing and placement; a row of elements
       invites counting them instead, which is reading Morse off a screen
       rather than learning to send it. Off by default all the same — it hides
       detail, and hiding detail is the user's call. */
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderView({ onChange, open: true });
    const box = byId("char-markers") as HTMLInputElement;
    expect(box.checked).toBe(false);
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith({ charMarkers: true });
  });


  it("offers the mode options whichever mode is picked", async () => {
    /* Set ahead of time: the options of Zen mode and of pacing stay live in
       every mode, so they can be ready before the mode is picked. */
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = renderView({ onChange, open: true });
    rerender(view({ zenMode: false, paceCursor: false }, onChange));
    for (const id of ["zen-progress", "pace-absolute", "pace-lead"]) {
      expect(byId(id), id).toBeEnabled();
    }
    // On to start.
    expect((byId("zen-progress") as HTMLInputElement).checked).toBe(true);
    await user.click(byId("zen-progress"));
    expect(onChange).toHaveBeenCalledWith({ zenProgress: false });
    const box = byId("pace-lead") as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "5");
    expect(onChange).toHaveBeenLastCalledWith({ paceLeadSec: 5 });
  });

  it("offers live grading in Plain mode, on to start and always live", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = renderView({ onChange, open: true });
    const box = container.querySelector<HTMLInputElement>("#plain-grading")!;
    expect(container.querySelector("[data-panel='modes']")).toContainElement(box);
    expect(box.checked).toBe(true);
    expect(box).toBeEnabled();
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith({ plainGrading: false });
  });

  it("bars live grading until live progress is on", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = renderView({ onChange, open: true });
    rerender(view({ zenMode: true, zenProgress: false }, onChange));
    // Zen's: Plain has one of its own, below.
    const box = () => document.querySelector<HTMLInputElement>("#zen-grading")!;
    expect(box()).toBeDisabled();
    expect(about(box().closest(".group"))).toMatch(/^Needs /);

    rerender(view({ zenMode: true, zenProgress: true }, onChange));
    expect(box()).toBeEnabled();
    expect(about(box().closest(".group"))).not.toMatch(/^Needs /);
    await user.click(box());
    expect(onChange).toHaveBeenCalledWith({ zenGrading: true });
  });

  it("offers no flash card", () => {
    renderView({ open: true });
    expect(screen.queryByLabelText(/flash card/i)).toBeNull();
    expect(screen.queryByLabelText(/word preview/i)).toBeNull();
  });


  it("follows the sending in Plain mode unless asked not to", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderView({ onChange, open: true });
    const box = byId("plain-follow") as HTMLInputElement;
    expect(box.checked, "on to start").toBe(true);
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith({ plainFollow: false });
  });

  it("leaves the choice of mode to the record bar", () => {
    /* Zen mode and the cursor are picked beside the record button. The panel
       holds only their options. */
    renderView({ open: true });
    expect(document.querySelector("#zen-mode")).toBeNull();
    expect(document.querySelector("#pace-cursor")).toBeNull();
  });


  it("does not fight the caret while the count-in is being typed", async () => {
    /* The trap every number box here has fallen into: emptying "3" to type "5"
       hands back an empty string, the old value goes straight back under the
       caret, and you end up with 35 — which then clamps to the maximum and
       looks like the control ignoring you. */
    const user = userEvent.setup();
    const box = renderStateful();
    await user.clear(box());
    await user.type(box(), "5");
    expect(box().value).toBe("5");
  });

  it("keeps the count-in inside what the chart can draw", async () => {
    /* Typed, not dragged, so there is nothing stopping somebody entering 400.
       The chart would reserve four hundred seconds of empty axis and the
       recording would look like it never started. */
    const user = userEvent.setup();
    const box = renderStateful();
    await user.clear(box());
    await user.type(box(), "400");
    // What is committed is clamped even while the field still reads 400 —
    // and leaving the field shows what was actually kept.
    await user.tab();
    expect(Number(box().value)).toBe(PACE_LEAD_MAX_SEC);
  });

  it("asks how long a break is, with or without the pacing aids", async () => {
    /* A break sets the target audio as well as the cursor, so the field is
       there whatever else is on. */
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderView({ onChange, open: true });
    const box = byId("break-sec") as HTMLInputElement;
    expect(box.value).toBe(String(defaults().breakSec));
    await user.clear(box);
    await user.type(box, "12");
    expect(onChange).toHaveBeenLastCalledWith({ breakSec: 12 });
    await user.clear(box);
    await user.type(box, "99");
    expect(onChange).toHaveBeenLastCalledWith({ breakSec: BREAK_MAX_SEC });
  });

  it("calls fit when the Fit button is pressed", async () => {
    const user = userEvent.setup();
    const onFit = vi.fn();
    const take = takeFrom(caseNamed(SLOPPY));
    render(
      <ViewControls runs={1} settings={defaultSettings(take)} onChange={() => {}} onFit={onFit} />,
    );
    await user.click(screen.getByRole("button", { name: "Fit" }));
    expect(onFit).toHaveBeenCalledOnce();
  });
});

describe("the Audio group", () => {
  /** A saved calibration, so the picker has something to offer. */
  const PROFILE: Profile = {
    id: "p1",
    nickname: "shack desk",
    deviceId: undefined,
    deviceLabel: undefined,
    wpm: 20,
    releaseOffsetSec: 0.003,
    measuredOffsetSec: 0.003,
    spreadSec: 0.0005,
    elements: 90,
    verdict: "good",
    decaySec: 0.02,
    maxWpm: 30,
    recordedAt: "2026-09-01T10:00:00+00:00",
  };
  const TWO = [
    { deviceId: "a", label: "one" },
    { deviceId: "b", label: "two" },
  ];

  function panel(audio: Partial<AudioSetup> = {}, fromFile = false) {
    return render(
      <ChartSettingsPanel
        settings={defaults()}
        onChange={() => {}}
        runs={1}
        audio={{
          devices: TWO,
          deviceId: undefined,
          onDeviceChange: () => {},
          profiles: [],
          profileId: undefined,
          onProfileChange: () => {},
          appliesToTake: !fromFile,
          rereading: false,
          onCalibrate: () => {},
          ...audio,
        }}
      />,
    );
  }
  const picker = () => screen.getByLabelText(/^calibration$/i) as HTMLSelectElement;
  const why = (el: HTMLElement) => about(el.closest(".group"));

  it("bars the microphone when there is only one input", () => {
    const one = panel({ devices: [{ deviceId: "a", label: "one" }] });
    const mic = screen.getByLabelText(/^microphone$/i);
    expect(mic).toBeDisabled();
    expect(why(mic)).toMatch(/only input/i);
    one.unmount();

    panel();
    expect(screen.getByLabelText(/^microphone$/i)).toBeEnabled();
  });

  it("bars the calibration picker when there is none to pick, and keeps Calibrate live", async () => {
    const onCalibrate = vi.fn();
    const none = panel({ onCalibrate });
    expect(picker()).toBeDisabled();
    expect(why(picker())).toMatch(/no calibration is saved/i);
    // The way out of the bar is beside it, and works.
    const button = screen.getByTestId("calibrate");
    expect(screen.getByTestId("calpick")).toContainElement(button);
    expect(button).toBeEnabled();
    button.click();
    expect(onCalibrate).toHaveBeenCalled();
    none.unmount();

    panel({ profiles: [PROFILE] });
    expect(picker()).toBeEnabled();
  });

  it("bars the calibration for a file, and does not claim one is in use", () => {
    panel({ profiles: [PROFILE], profileId: "p1" }, true);
    expect(picker()).toBeDisabled();
    expect(why(picker())).toMatch(/opened from disk/i);
    const title = screen.getByTestId("calibrate").getAttribute("title")!;
    expect(title).not.toMatch(/in use/i);
    expect(title).toMatch(PROFILE.nickname);
  });

  it("says a microphone take's calibration is in use", () => {
    panel({ profiles: [PROFILE], profileId: "p1" });
    expect(screen.getByTestId("calibrate").getAttribute("title")).toMatch(/in use/i);
  });

  it("bars the picker while the session is re-read", () => {
    panel({ profiles: [PROFILE], profileId: "p1", rereading: true });
    expect(picker()).toBeDisabled();
    expect(why(picker())).toMatch(/re-reading/i);
  });
});
