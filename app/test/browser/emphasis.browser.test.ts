/* Emphasis and hover have to be two different things.
 *
 * A control the page wants you to reach for is drawn in the accent, and so is
 * a control under the pointer. Drawn in the SAME accent, the emphasis reads as
 * a button that is permanently hovered and answers the pointer with nothing:
 * you are told "this one", and then told it again, which is the same as not
 * being told.
 *
 * So there are three states and they have to be three colors — the resting
 * border, the emphasis, and hover — with the emphasis between the other two
 * rather than equal to either. Read off the stylesheet and resolved by the
 * browser, because the emphasis is a color-mix: what it says and what it comes
 * out as are two different questions and only the second one is visible.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import "@/ui/base.css";

let probe: HTMLElement;

beforeEach(() => {
  probe = document.createElement("button");
  document.body.append(probe);
});

afterEach(() => probe.remove());

/** Chromium reports a color-mix result as `color(srgb 0.31 0.46 0.67)` and
 *  everything else as `rgb(79, 117, 171)`. Read as one scale, the mix comes
 *  out black and every comparison below passes for the wrong reason. */
function channels(color: string): [number, number, number] {
  const n = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  return (color.startsWith("color(") ? n.map((v) => v * 255) : n) as [number, number, number];
}

/** The border a button of this class is painted with. */
function painted(className: string): [number, number, number] {
  probe.className = className;
  return channels(getComputedStyle(probe).borderTopColor);
}

/** The border the hover rule asks for, resolved by the browser.
 *
 * :hover cannot be simulated from script, so this reads the rule and hands its
 * value back to the engine to compute — which is the same path the painted
 * ones take, one step later. */
function hovered(): [number, number, number] {
  let declared = "";
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules) as CSSStyleRule[]) {
      if (rule.selectorText === "button:hover:not(:disabled)") {
        declared = rule.style.getPropertyValue("border-color");
      }
    }
  }
  if (!declared) throw new Error("no border-color on the button hover rule");
  probe.className = "";
  probe.style.borderColor = declared;
  const got = getComputedStyle(probe).borderTopColor;
  probe.style.borderColor = "";
  return channels(got);
}

const apart = (a: number[], b: number[]) =>
  Math.hypot(...a.map((v, i) => v - b[i]!));

describe("the accent, at two strengths", () => {
  it("does not draw emphasis in the hover color", () => {
    /* The bug this exists for: `button.primary` and `button:hover` both set
       border-color to var(--you), and the emphasized button looks hovered
       before anyone has pointed at it. */
    expect(apart(painted("primary"), hovered())).toBeGreaterThan(20);
  });

  it("still reads as emphasis against a control at rest", () => {
    expect(apart(painted("primary"), painted(""))).toBeGreaterThan(20);
  });

  it("is the accent stood back from, not a third color", () => {
    /* Between the two, and on the accent's side of the gap: dialing it back
       must not turn it into some unrelated hue that happens to differ from
       both. */
    const hover = hovered();
    expect(apart(painted("primary"), hover)).toBeLessThan(apart(painted(""), hover));
  });

  it("leaves hover somewhere to go from either", () => {
    // Pointing at an ordinary button and at the emphasized one both change it.
    const hover = hovered();
    expect(apart(painted(""), hover)).toBeGreaterThan(20);
    expect(apart(painted("primary"), hover)).toBeGreaterThan(20);
  });
});
