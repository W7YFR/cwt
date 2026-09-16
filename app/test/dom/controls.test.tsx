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
import { defaultSettings } from "@/timing";
import { PACE_LEAD_MAX_SEC } from "@/render/geometry";
import type { ReviewSettings } from "@/types";
import { caseNamed, SLOPPY } from "../fixture";
import { takeFrom } from "../fixture";

function Harness({
  initial,
  onSettings,
}: {
  initial?: Partial<ReviewSettings>;
  onSettings?: (s: ReviewSettings) => void;
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
      playing={null}
      canPlayYou
      clock={null}
      onPlayYou={() => {}}
      onPlayTarget={() => {}}
      onStop={() => {}}
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
  return () => screen.getByLabelText(/delay start/i) as HTMLInputElement;
}

describe("controls", () => {
  it("shows every reading padded to a constant width", () => {
    // The whole reason for the padding: the groups are sized by their content
    // and the intended-message field absorbs the slack, so a reading that
    // gains a digit drags the row and wraps the caption beside it. Dragging a
    // slider made that twitch once; zooming with the wheel made it constant.
    const READOUTS = ["wpm-out", "farns-out", "tol-out", "gain-out"];
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
    expect(screen.getByLabelText(/chart controls/i)).toBeTruthy();
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
    expect(screen.queryByLabelText(/collapse rests/i)).toBeNull();
    expect(screen.queryByLabelText(/pacing cursor/i)).toBeNull();

    const cog = screen.getByTestId("panel-toggle");
    expect(cog.getAttribute("aria-pressed")).toBe("false");
    await user.click(cog);

    // Both bands at once: what is drawn, and what runs while you send.
    expect(cog.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText(/collapse rests/i)).toBeTruthy();
    expect(screen.getByLabelText(/pacing cursor/i)).toBeTruthy();
    // And the axis never went anywhere.
    expect(container.querySelector("#view")).not.toBeNull();

    // The cog is the way back out as well as the way in.
    await user.click(cog);
    expect(screen.queryByLabelText(/collapse rests/i)).toBeNull();
    expect(screen.queryByLabelText(/pacing cursor/i)).toBeNull();
  });

  it("names the two halves, because half of them do nothing to the chart", async () => {
    /* Eleven checkboxes in one heap is what this replaced. The pacing cursor
       and the flash card change nothing about the chart in front of you —
       they run while you send — and the row they sit under says so. */
    const user = userEvent.setup();
    const { container } = renderView({ runs: 3 });
    await user.click(screen.getByTestId("panel-toggle"));

    const display = container.querySelector("[data-panel='display']")!;
    const practice = container.querySelector("[data-panel='practice']")!;
    expect(display).toContainElement(screen.getByLabelText(/collapse rests/i));
    expect(display).toContainElement(screen.getByLabelText(/^scores$/i));
    expect(practice).toContainElement(screen.getByLabelText(/pacing cursor/i));
    expect(practice).toContainElement(screen.getByLabelText(/flash card/i));
    for (const row of [display, practice]) {
      expect(row.querySelector(".uplabel")!.textContent).not.toBe("");
    }
  });

  it("offers what to draw on a stack only when there is a stack", async () => {
    /* Both controls are about attempts side by side. With one on screen the
       scores would repeat the band under the chart and there is no "every row"
       to caption, so neither is a question worth putting in a row that already
       carries eight. */
    const user = userEvent.setup();
    const seen: Partial<ReviewSettings>[] = [];
    const { unmount } = renderView({ runs: 1 });
    expect(screen.queryByLabelText(/^scores$/i)).toBeNull();
    expect(screen.queryByLabelText(/decode all/i)).toBeNull();
    unmount();

    renderView({ runs: 3, onChange: (p) => seen.push(p), open: true });
    await user.click(screen.getByLabelText(/^scores$/i));
    await user.click(screen.getByLabelText(/decode all/i));
    // Defaults are scores on, one caption — so each click is the other way.
    expect(seen).toEqual([{ runScores: false }, { captionAll: true }]);
  });

  it("offers an order only where there is more than one row to order", () => {
    /* One row has exactly one arrangement. That is a session with one attempt
       in it, and — the case this is really about — a session drawing only its
       last: Show has already answered what is on screen, and a Sort that
       redraws the same picture whatever it is set to is furniture. */
    const { unmount } = renderView({ runs: 3 });
    expect(screen.getByLabelText(/^sort$/i)).toBeInTheDocument();
    unmount();

    const shrunk = renderView({ runs: 3, over: { showRuns: "last" } });
    expect(screen.queryByLabelText(/^sort$/i)).toBeNull();
    // And Show stays, or there would be no way back out of it.
    expect(screen.getByLabelText(/^show$/i)).toBeInTheDocument();
    shrunk.unmount();

    // A window wider than one row still has an order to choose.
    renderView({ runs: 3, over: { showRuns: "last3" } });
    expect(screen.getByLabelText(/^sort$/i)).toBeInTheDocument();
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
      [/chart controls/i, true, { showChartControls: false }],
      [/^downloads$/i, false, { showDownloads: true }],
      [/^hints$/i, true, { showHints: false }],
      [/advanced grading/i, true, { advancedGrading: false }],
    ] as const;
    for (const [label, on, patch] of boxes) {
      const box = screen.getByLabelText(label) as HTMLInputElement;
      expect(box.checked, String(label)).toBe(on);
      expect(extras, String(label)).toContainElement(box);
      await user.click(box);
      expect(seen.at(-1), String(label)).toEqual(patch);
    }

    // And the chart band keeps only the four that change how it is drawn.
    expect(chart.querySelectorAll("input[type='checkbox']")).toHaveLength(4);
  });

  it("disables stop when nothing is playing and enables it when something is", () => {
    const take = takeFrom(caseNamed(SLOPPY));
    const base = defaultSettings(take);
    const common = {
      settings: base,
      onChange: () => {},
      canPlayYou: true,
      clock: null,
      onPlayYou: () => {},
      onPlayTarget: () => {},
      onStop: () => {},
    };
    const { rerender } = render(<Controls {...common} playing={null} />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    rerender(<Controls {...common} playing="you" />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("swaps only the icon when playback starts, so the row cannot shift", () => {
    const take = takeFrom(caseNamed(SLOPPY));
    const common = {
      settings: defaultSettings(take),
      onChange: () => {},
      canPlayYou: true,
      clock: null,
      onPlayYou: () => {},
      onPlayTarget: () => {},
      onStop: () => {},
    };
    const { rerender } = render(<Controls {...common} playing={null} />);
    const button = screen.getByRole("button", { name: /Your sending/ });
    expect(button.querySelector(".ico")!.textContent).toBe("▶");
    rerender(<Controls {...common} playing="you" />);
    expect(button.querySelector(".ico")!.textContent).toBe("■");
    // The words either side of the icon are unchanged, which is what keeps the
    // button's width — and everything to its right — from moving.
    expect(button.textContent).toContain("Your sending");
  });

  it("says what an empty intended message means, inside the box", () => {
    const take = takeFrom(caseNamed(SLOPPY));
    const common = {
      onChange: () => {},
      playing: null,
      canPlayYou: true,
      clock: null,
      onPlayYou: () => {},
      onPlayTarget: () => {},
      onStop: () => {},
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

  it("offers characters as start markers, off unless asked for", async () => {
    /* What the trainer is for is spacing and placement; a row of elements
       invites counting them instead, which is reading Morse off a screen
       rather than learning to send it. Off by default all the same — it hides
       detail, and hiding detail is the user's call. */
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderView({ onChange, open: true });
    const box = screen.getByLabelText(/marks only/i) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith({ charMarkers: true });
  });

  it("keeps the flash card and its cue as two separate choices", async () => {
    /* A reference you glance at and a cue you react to are different things,
       and the cue's lead is a setting for nothing with no cue to lead. */
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = renderView({ onChange, open: true });
    expect(screen.queryByLabelText(/flash cue/i)).toBeNull();
    expect(screen.queryByLabelText(/flash lead/i)).toBeNull();

    await user.click(screen.getByLabelText(/flash card/i));
    expect(onChange).toHaveBeenCalledWith({ flashCard: true });

    rerender(view({ flashCard: true, flashCue: false }, onChange));
    expect(screen.getByLabelText(/flash cue/i)).toBeTruthy();
    // No lead without a flash to lead.
    expect(screen.queryByLabelText(/flash lead/i)).toBeNull();

    rerender(view({ flashCard: true, flashCue: true }, onChange));
    expect(screen.getByLabelText(/flash lead/i)).toBeTruthy();
  });

  it("offers the word preview only with a card to put it under", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = renderView({ onChange, open: true });
    expect(screen.queryByLabelText(/word preview/i)).toBeNull();

    /* It hangs off the card rather than off the cue: it is something to read,
       not something to react to, so the flash being off is no reason to
       withhold it. */
    rerender(view({ flashCard: true, flashCue: false }, onChange));
    await user.click(screen.getByLabelText(/word preview/i));
    expect(onChange).toHaveBeenCalledWith({ wordPreview: true });
  });

  it("offers the pacing cursor, off unless asked for", async () => {
    /* A practice aid rather than a way of reading the chart, so it is opt-in —
       and it sits with the other things that run while you send rather than
       with the things that change what is drawn or what is graded. */
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderView({ onChange, open: true });
    const box = screen.getByLabelText(/pacing cursor/i) as HTMLInputElement;
    expect(box.checked).toBe(false);

    await user.click(box);
    expect(onChange).toHaveBeenCalledWith({ paceCursor: true });
  });

  it("asks how long the count-in should be, only once there is one", async () => {
    /* A count-in for a cursor that is not running is a setting for nothing,
       and one more control in a row that is already busy. */
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = renderView({ onChange, open: true });
    expect(screen.queryByLabelText(/delay start/i)).toBeNull();

    rerender(view({ paceCursor: true }, onChange));
    const box = screen.getByLabelText(/delay start/i) as HTMLInputElement;
    expect(box.value).toBe(String(defaults().paceLeadSec));

    await user.clear(box);
    await user.type(box, "5");
    expect(onChange).toHaveBeenLastCalledWith({ paceLeadSec: 5 });
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
