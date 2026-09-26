/* The headline band, and the actions in it.
 *
 * Dropping a run belongs here rather than up with the record controls: this
 * band IS the attempt being read — its consistency, its accuracy, the speed it
 * came out at — and deciding to throw one away is something you do while
 * looking at those numbers.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Scores } from "@/ui/Scores";
import { fitSpeed, SPEED_MAX, SPEED_MIN } from "@/ui/Controls";
import { defaultSettings } from "@/timing";
import { blankTake } from "@/io/take";
import { caseNamed, reviewFrom, SLOPPY } from "../fixture";

function band(over: Partial<React.ComponentProps<typeof Scores>> = {}) {
  const { take, settings, review } = reviewFrom(caseNamed(SLOPPY));
  const onDrop = vi.fn();
  const onFit = vi.fn();
  render(
    <Scores
      review={review}
      settings={settings}
      take={take}
      onDrop={onDrop}
      onFit={onFit}
      runOf={{ at: 0, of: 1 }}
      {...over}
    />,
  );
  return { onDrop, onFit, take };
}

describe("which attempt the band is about", () => {
  it("names the run, the way the chart names it", () => {
    /* Everything in this band, and every table under it, is one attempt. With
       a stack on the chart which one was only findable by noticing where the
       caption band had moved to — and counted the way the chart counts, so the
       name here and the row up there cannot disagree. */
    band({ runOf: { at: 2, of: 4 } });
    expect(screen.getByTestId("run-name").textContent).toContain("3");
  });

  it("names a lone run once it is recorded", () => {
    band({ runOf: { at: 0, of: 1 } });
    expect(screen.getByTestId("run-name").textContent).toContain("1");
  });

  it("says nothing for a lone run with nothing recorded", () => {
    const take = blankTake({ expected: "CQ", charWpm: 20, farnsworthWpm: 20 });
    render(
      <Scores
        review={reviewFrom(caseNamed(SLOPPY)).review}
        settings={defaultSettings(take)}
        take={take}
        runOf={{ at: 0, of: 1 }}
      />,
    );
    expect(screen.queryByTestId("run-name")).toBeNull();
  });

  it("names it even with nothing recorded into it yet", () => {
    /* The dashes are still about one attempt: recording into a session leaves
       the earlier ones on the chart, and which row the empty one is is the
       same question. */
    const take = blankTake({ expected: "CQ", charWpm: 20, farnsworthWpm: 20 });
    const settings = defaultSettings(take);
    const { review } = reviewFrom(caseNamed(SLOPPY));
    render(
      <Scores
        review={review}
        settings={settings}
        take={take}
        runOf={{ at: 3, of: 4 }}
      />,
    );
    expect(screen.getByTestId("run-name").textContent).toContain("4");
  });
});

describe("dropping a run from the scores", () => {
  it("is offered for a lone recorded run", () => {
    band({ runOf: { at: 0, of: 1 } });
    expect(screen.getByTestId("drop-run")).toBeTruthy();
  });

  it("names the attempt it will throw away", () => {
    /* Counted the way the chart counts, which is the order it was recorded in
       — so the button and the row it refers to cannot disagree. In its name
       rather than its text: the button is an icon, and the name is what it is
       called for anyone who cannot see one. */
    band({ runOf: { at: 2, of: 4 } });
    expect(screen.getByTestId("drop-run").getAttribute("aria-label")).toContain("3");
  });

  it("throws it away when asked", () => {
    const { onDrop } = band({ runOf: { at: 1, of: 3 } });
    screen.getByTestId("drop-run").click();
    expect(onDrop).toHaveBeenCalled();
  });

  it("stays out of a band with no recording behind it", () => {
    /* The figures are dashes, which is not a set of numbers to act on. */
    const take = blankTake({ expected: "CQ", charWpm: 20, farnsworthWpm: 20 });
    const settings = defaultSettings(take);
    render(
      <Scores
        review={reviewFrom(caseNamed(SLOPPY)).review}
        settings={settings}
        take={take}
        onDrop={() => {}}
        runOf={{ at: 0, of: 3 }}
      />,
    );
    expect(screen.queryByTestId("drop-run")).toBeNull();
  });
});

describe("fitting the target to a run", () => {
  it("sits beside the drop button and asks for the fit", () => {
    const { onFit } = band();
    screen.getByTestId("fit-wpm").click();
    expect(onFit).toHaveBeenCalled();
  });

  it("stays out of a band with no recording behind it", () => {
    const take = blankTake({ expected: "CQ", charWpm: 20, farnsworthWpm: 20 });
    render(
      <Scores
        review={reviewFrom(caseNamed(SLOPPY)).review}
        settings={defaultSettings(take)}
        take={take}
        onFit={() => {}}
        runOf={{ at: 0, of: 1 }}
      />,
    );
    expect(screen.queryByTestId("fit-wpm")).toBeNull();
  });

  it("rounds the measured speeds to what the sliders hold", () => {
    const { take } = reviewFrom(caseNamed(SLOPPY));
    const fit = fitSpeed(take.measured)!;
    expect(fit.charWpm).toBe(Math.round(take.measured.charWpm));
    expect(fit.farnsworthWpm).toBe(
      Math.min(Math.round(take.measured.farnsworthWpm), fit.charWpm),
    );
  });

  it("keeps the fit inside the slider range, overall never above character", () => {
    const m = reviewFrom(caseNamed(SLOPPY)).take.measured;
    expect(fitSpeed({ ...m, charWpm: 80, farnsworthWpm: 90 })).toEqual({
      charWpm: SPEED_MAX,
      farnsworthWpm: SPEED_MAX,
    });
    expect(fitSpeed({ ...m, charWpm: 2, farnsworthWpm: 1 })).toEqual({
      charWpm: SPEED_MIN,
      farnsworthWpm: SPEED_MIN,
    });
    expect(fitSpeed({ ...m, charWpm: 0, farnsworthWpm: 0 })).toBeNull();
  });
});
