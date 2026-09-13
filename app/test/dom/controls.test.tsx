/* The control row, against a real DOM.
 *
 * These are about wiring and about the constraints between controls — the
 * things that are invisible in a screenshot and obvious the moment they break.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Controls, ViewControls } from "@/ui/Controls";
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
      hasExpected
      playing={null}
      clock={null}
      onPlayYou={() => {}}
      onPlayTarget={() => {}}
      onStop={() => {}}
    />
  );
}

const defaults = () => defaultSettings(takeFrom(caseNamed(SLOPPY)));

function view(over: Partial<ReviewSettings>, onChange: (p: Partial<ReviewSettings>) => void) {
  return <ViewControls settings={{ ...defaults(), ...over }} onChange={onChange} onFit={() => {}} />;
}

function renderView({
  over = {},
  onChange = () => {},
}: { over?: Partial<ReviewSettings>; onChange?: (p: Partial<ReviewSettings>) => void } = {}) {
  return render(view(over, onChange));
}

/** The view controls wired to real state, for the boxes whose behavior is in
 *  the round trip rather than in a single render. */
function renderStateful() {
  function Harnessed() {
    const [s, set] = useState<ReviewSettings>({ ...defaults(), paceCursor: true });
    return (
      <ViewControls
        settings={s}
        onChange={(patch) => set((prev) => ({ ...prev, ...patch }))}
        onFit={() => {}}
      />
    );
  }
  render(<Harnessed />);
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
    const box = screen.getByLabelText(/Intended message/i);
    await user.clear(box);
    await user.type(box, "cq de w7yfr");
    expect(seen.at(-1)?.expected).toBe("CQ DE W7YFR");
  });

  it("disables stop when nothing is playing and enables it when something is", () => {
    const take = takeFrom(caseNamed(SLOPPY));
    const base = defaultSettings(take);
    const common = {
      settings: base,
      onChange: () => {},
        hasExpected: false,
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
        hasExpected: false,
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

  it("says so when no intended message was given", () => {
    const take = takeFrom(caseNamed(SLOPPY));
    render(
      <Controls
        settings={defaultSettings(take)}
        onChange={() => {}}
        hasExpected={false}
        playing={null}
        clock={null}
        onPlayYou={() => {}}
        onPlayTarget={() => {}}
        onStop={() => {}}
        />,
    );
    // Otherwise the accuracy figure reads as a grade rather than as a
    // tautology, which is exactly the misunderstanding worth heading off.
    expect(screen.getByText(/grading against your own decode/i)).toBeInTheDocument();
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
      <ViewControls
        settings={defaultSettings(take)}
        onChange={() => {}}
        onFit={() => {}}
      />,
    );
    for (const id of ["view", "zoom", "zoom-fit"]) {
      expect(document.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("offers the pacing cursor, off unless asked for", async () => {
    /* A practice aid rather than a way of reading the chart, so it is opt-in —
       and it sits with the other things that change what is on screen rather
       than with the things that change the grade. */
    const user = userEvent.setup();
    const take = takeFrom(caseNamed(SLOPPY));
    const onChange = vi.fn();
    render(
      <ViewControls
        settings={defaultSettings(take)}
        onChange={onChange}
        onFit={() => {}}
      />,
    );
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
    const { rerender } = renderView({ onChange });
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
      <ViewControls settings={defaultSettings(take)} onChange={() => {}} onFit={onFit} />,
    );
    await user.click(screen.getByRole("button", { name: "Fit" }));
    expect(onFit).toHaveBeenCalledOnce();
  });
});
