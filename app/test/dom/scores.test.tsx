/* The headline band, and the one action in it.
 *
 * Dropping a run belongs here rather than up with the record controls: this
 * band IS the attempt being read — its consistency, its accuracy, the speed it
 * came out at — and deciding to throw one away is something you do while
 * looking at those numbers.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Scores } from "@/ui/Scores";
import { defaultSettings } from "@/timing";
import { blankTake } from "@/io/take";
import { caseNamed, reviewFrom, SLOPPY } from "../fixture";

function band(over: Partial<React.ComponentProps<typeof Scores>> = {}) {
  const { take, settings, review } = reviewFrom(caseNamed(SLOPPY));
  const onDrop = vi.fn();
  render(
    <Scores
      review={review}
      settings={settings}
      take={take}
      onDrop={onDrop}
      runOf={{ at: 0, of: 1 }}
      {...over}
    />,
  );
  return { onDrop };
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

  it("says nothing when there is only one of them", () => {
    // Nothing for it to be distinguished from.
    band({ runOf: { at: 0, of: 1 } });
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
  it("is not offered when there is nothing else to keep", () => {
    /* With one attempt on screen, dropping it and clearing the session are the
       same act, and two buttons for one question is one too many. */
    band({ runOf: { at: 0, of: 1 } });
    expect(screen.queryByTestId("drop-run")).toBeNull();
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
    /* Nothing recorded means one attempt, so there is nothing to drop — and
       the figures are dashes, which is not a set of numbers to act on. */
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
