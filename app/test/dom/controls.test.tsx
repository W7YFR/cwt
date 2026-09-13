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
