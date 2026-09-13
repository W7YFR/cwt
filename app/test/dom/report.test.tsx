/* The report tables and the header scores. */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Report } from "@/ui/Report";
import { Scores } from "@/ui/Scores";
import { CLASS_LABEL } from "@/ui/copy";
import { slotIndexAtTime } from "@/render/focus";
import { caseNamed, reviewFrom, CLEAN, SLOPPY } from "../fixture";

describe("the report", () => {
  const { review, settings } = reviewFrom(caseNamed(SLOPPY));

  it("lists every graded class with its measured and target figures", () => {
    render(
      <Report
        review={review}
        tolerance={settings.tolerance}
        onPlayDeviation={() => {}}
        onFocus={() => {}}
      />,
    );
    for (const stat of review.analysis.stats) {
      const cell = screen.getAllByText(CLASS_LABEL[stat.name])[0]!;
      const row = cell.closest("tr")!;
      expect(within(row).getByText(`${stat.meanUnits.toFixed(2)}u`)).toBeInTheDocument();
      expect(within(row).getByText(`${stat.targetUnits.toFixed(2)}u`)).toBeInTheDocument();
      expect(within(row).getByText(String(stat.n))).toBeInTheDocument();
    }
  });

  it("explains what each class means, on the class name itself", () => {
    render(
      <Report
        review={review}
        tolerance={settings.tolerance}
        onPlayDeviation={() => {}}
        onFocus={() => {}}
      />,
    );
    // The names are only obvious once you know the model: "intra-char gap"
    // reads as the gap BETWEEN characters, which is a different class with a
    // target three times the size.
    const cell = screen.getAllByText(CLASS_LABEL["element-gap"])[0]!;
    const title = cell.getAttribute("title")!;
    expect(title).toContain("INSIDE");
    expect(title.length).toBeGreaterThan(60);
    expect(cell).toHaveClass("why");
  });

  it("makes both sides of a deviation playable, scoped to its own class", async () => {
    const user = userEvent.setup();
    const played: Array<[string, number, string]> = [];
    render(
      <Report
        review={review}
        tolerance={settings.tolerance}
        onPlayDeviation={(side, idx, kind) => played.push([side, idx, kind])}
        onFocus={() => {}}
      />,
    );
    const dev = review.analysis.deviations[0]!;
    const expectedIdx = slotIndexAtTime(review.slots, dev.timeSec);

    await user.click(screen.getAllByTitle("hear yours")[0]!);
    await user.click(screen.getAllByTitle("hear the target")[0]!);

    expect(played).toEqual([
      ["you", expectedIdx, dev.kind],
      ["tgt", expectedIdx, dev.kind],
    ]);
  });

  it("focuses the same row on hover as the one it would play", async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    render(
      <Report
        review={review}
        tolerance={settings.tolerance}
        onPlayDeviation={() => {}}
        onFocus={onFocus}
      />,
    );
    const dev = review.analysis.deviations[0]!;
    const idx = slotIndexAtTime(review.slots, dev.timeSec);

    await user.hover(screen.getAllByTitle("hear yours")[0]!);
    expect(onFocus).toHaveBeenLastCalledWith({ side: "you", idx, kind: dev.kind });
    await user.unhover(screen.getAllByTitle("hear yours")[0]!);
    expect(onFocus).toHaveBeenLastCalledWith(null);

    // Hovering the target cell lights the OTHER track, which is the whole
    // point of having two separate cells.
    await user.hover(screen.getAllByTitle("hear the target")[0]!);
    expect(onFocus).toHaveBeenLastCalledWith({ side: "tgt", idx, kind: dev.kind });
  });

  it("gives credit, and a next step, when there is nothing to fix", () => {
    const { review: clean, settings: cleanSettings } = reviewFrom(caseNamed(CLEAN), {
      tolerance: 0.6,
    });
    render(
      <Report
        review={clean}
        tolerance={cleanSettings.tolerance}
        onPlayDeviation={() => {}}
        onFocus={() => {}}
      />,
    );
    // Not just "no deviations": an empty table is the best result the tool can
    // report, and it should read like one and say what to try next.
    expect(screen.getByText(/clean sending/i)).toBeInTheDocument();
    expect(screen.getByText(/tighter tolerance|higher speed/i)).toBeInTheDocument();
  });

  it("shows the accuracy diff only when there is an intended message", () => {
    const { review: withText } = reviewFrom(caseNamed(SLOPPY));
    const { rerender } = render(
      <Report
        review={withText}
        tolerance={0.3}
        onPlayDeviation={() => {}}
        onFocus={() => {}}
      />,
    );
    expect(screen.getByText(/Accuracy vs intended text/)).toBeInTheDocument();

    const { review: noText } = reviewFrom(caseNamed(SLOPPY), { expected: "" });
    rerender(
      <Report
        review={noText}
        tolerance={0.3}
        onPlayDeviation={() => {}}
        onFocus={() => {}}
      />,
    );
    // Grading a decode against itself is a meaningless 100%, so the panel is
    // absent rather than showing a perfect score nobody earned.
    expect(screen.queryByText(/Accuracy vs intended text/)).not.toBeInTheDocument();
  });

  it("shows both texts whole, not only where they parted company", () => {
    /* The diff marks up the differences and never shows either text entire,
       and "3 sub · 1 extra" means very little until you can see what was asked
       for and what came back. */
    const { review } = reviewFrom(caseNamed(SLOPPY));
    render(
      <Report
        review={review}
        tolerance={0.3}
        onPlayDeviation={() => {}}
        onFocus={() => {}}
      />,
    );
    const c = review.comparison!;
    expect(screen.getByTestId("intended-text").textContent).toBe(c.expected);
    expect(screen.getByTestId("decoded-text").textContent).toBe(c.decoded);
  });

  it("counts the rests it left out of the grade", () => {
    const { review: rested } = reviewFrom(caseNamed(SLOPPY), { collapseRests: true });
    if (rested.analysis.nPauses === 0) return;
    render(
      <Report
        review={rested}
        tolerance={0.3}
        onPlayDeviation={() => {}}
        onFocus={() => {}}
      />,
    );
    expect(screen.getByText(/pause/)).toBeInTheDocument();
  });
});

describe("the scores", () => {
  it("shows consistency, speed and tone, and accuracy only when earned", () => {
    const { review, settings, take } = reviewFrom(caseNamed(SLOPPY));
    const { rerender, container } = render(
      <Scores review={review} settings={settings} take={take} />,
    );
    expect(screen.getByText("consistent")).toBeInTheDocument();
    expect(screen.getByText("accurate")).toBeInTheDocument();
    expect(container.textContent).toContain("Hz tone");
    expect(container.textContent).toContain("wpm sent");

    const { review: bare, settings: bareSettings } = reviewFrom(caseNamed(SLOPPY), {
      expected: "",
    });
    rerender(<Scores review={bare} settings={bareSettings} take={take} />);
    expect(screen.queryByText("accurate")).not.toBeInTheDocument();
  });

  it("grades the headline consistency figure by how good it is", () => {
    const { review, settings, take } = reviewFrom(caseNamed(CLEAN), { tolerance: 0.6 });
    const { container } = render(
      <Scores review={review} settings={settings} take={take} />,
    );
    const consistent = container.querySelector(".score")!;
    // A machine keyer inside a generous tolerance had better read green.
    expect(consistent.className).toContain("ok");
  });
});
