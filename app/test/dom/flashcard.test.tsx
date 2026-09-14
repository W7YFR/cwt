/* The next character, and the cue that says now.
 *
 * Driven by feeding it a clock, because that is what it is: a reading of one
 * schedule against the recorder's own time. Nothing here renders the review —
 * what the card does with a schedule is separable from how the schedule is
 * built, and the second half is settled where the beats are computed.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { FlashCard, type Beat, type Word } from "@/ui/FlashCard";
import { FLASH_SEC } from "@/render/geometry";

/* The card reads the clock on its own animation frames and writes straight to
   the DOM — no state, no re-render — so a test has to drive frames rather than
   await renders. */
function useFrames() {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return () => {
    const due = queue.splice(0, queue.length);
    act(() => due.forEach((cb) => cb(0)));
  };
}

const BEATS: Beat[] = [
  { char: "C", at: 3 },
  { char: "Q", at: 4 },
  { char: "K", at: 6 },
];

/* "CQ K" — two words, so the preview has a boundary to cross. */
const WORDS: Word[] = [
  { from: 0, to: 2, chars: ["C", "Q"] },
  { from: 2, to: 3, chars: ["K"] },
];

const letter = () => screen.getByTestId("flashcard-letter").textContent;
const clock = () => screen.getByTestId("flashcard-clock").textContent;
const lit = () => screen.getByTestId("flashcard").classList.contains("now");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(over: Partial<React.ComponentProps<typeof FlashCard>> = {}) {
  const frame = useFrames();
  let now = 0;
  const view = render(
    <FlashCard
      beats={BEATS}
      cue
      leadSec={0.2}
      elapsed={() => now}
      words={[]}
      {...over}
    />,
  );
  return {
    ...view,
    at(t: number) {
      now = t;
      frame();
      // One more, because a frame schedules the next one.
      frame();
    },
  };
}

describe("the flash card", () => {
  it("shows what is coming, not what has gone", () => {
    const card = mount();
    card.at(0);
    expect(letter()).toBe("C");
    // Past the first beat, the second is what is next.
    card.at(3.5);
    expect(letter()).toBe("Q");
    card.at(5);
    expect(letter()).toBe("K");
  });

  it("counts down in tenths to the character it is showing", () => {
    const card = mount();
    card.at(1.4);
    expect(clock()).toBe("1.6s");
    card.at(2.9);
    expect(clock()).toBe("0.1s");
  });

  it("keeps the character up through its own cue", () => {
    /* The flash fires early, and what you are looking at while you send is
       the thing you are sending — advancing on the flash would put the NEXT
       character in front of you at the moment you key this one. */
    const card = mount();
    card.at(3 - 0.1);
    expect(lit()).toBe(true);
    expect(letter()).toBe("C");
  });

  it("lights ahead of the beat, by the amount it was given", () => {
    const card = mount({ leadSec: 0.5 });
    card.at(3 - 0.6);
    expect(lit(), "too early").toBe(false);
    card.at(3 - 0.5 + FLASH_SEC / 2);
    expect(lit(), "on the lead").toBe(true);
    card.at(3 - 0.5 + FLASH_SEC * 2);
    expect(lit(), "and over").toBe(false);
  });

  it("does not move the countdown with the flash", () => {
    /* Two different ideas of "now" on one card would be worse than no cue at
       all. The clock is the clock; only the flash runs early. */
    const early = mount({ leadSec: 0.5 });
    early.at(2.5);
    const withLead = clock();
    cleanup();

    const none = mount({ leadSec: 0 });
    none.at(2.5);
    expect(clock()).toBe(withLead);
  });

  it("shows the card without lighting it when the cue is off", () => {
    // Two separate things: a reference you glance at, and a cue you react to.
    const card = mount({ cue: false });
    card.at(3 - 0.1);
    expect(letter()).toBe("C");
    expect(lit()).toBe(false);
  });

  it("sits armed when nothing is recording", () => {
    // Visibly ready, showing what it is about to ask for.
    mount({ elapsed: null });
    expect(letter()).toBe("C");
    expect(clock()).toBe("—");
    expect(lit()).toBe(false);
  });

  it("has nothing left to say after the last character", () => {
    const card = mount();
    card.at(7);
    expect(letter()).toBe("·");
    expect(clock()).toBe("—");
    expect(lit()).toBe(false);
  });
});

describe("the word preview", () => {
  const spelled = () =>
    Array.from(screen.getByTestId("flashcard-word").children).map((el) => ({
      ch: el.textContent,
      done: el.classList.contains("done"),
    }));
  const text = () => spelled().map((s) => s.ch).join("");
  const green = () =>
    spelled().filter((s) => s.done).map((s) => s.ch).join("");

  it("is not there at all unless asked for", () => {
    mount();
    expect(screen.queryByTestId("flashcard-word")).toBeNull();
  });

  it("spells the word the next character is in", () => {
    const card = mount({ words: WORDS });
    card.at(0);
    expect(text()).toBe("CQ");
  });

  it("greens each letter once it has been passed", () => {
    const card = mount({ words: WORDS });
    card.at(0);
    expect(green()).toBe("");
    // The C is due at 3. A moment after, it has been sent.
    card.at(3.2);
    expect(green()).toBe("C");
    card.at(4.2);
    expect(green()).toBe("CQ");
  });

  it("holds a finished word before swapping in the next one", () => {
    /* Q is due at 4 and K at 6, so the changeover is at 5. Before it you can
       see the word you just finished, complete — which is the one thing the
       last letter of a word could never show if the preview followed the next
       character instead of the nearest one. */
    const card = mount({ words: WORDS });
    card.at(4.2);
    expect(text()).toBe("CQ");
    expect(green()).toBe("CQ");

    card.at(5.4);
    expect(text()).toBe("K");
    expect(green()).toBe("");

    card.at(6.1);
    expect(green()).toBe("K");
  });

  it("keeps the last word up, finished, after the message ends", () => {
    /* Taking it away at the final character would blank the preview exactly
       as it completes — the one moment it has something to show. */
    const card = mount({ words: WORDS });
    card.at(99);
    expect(letter()).toBe("\u00b7");
    expect(text()).toBe("K");
    expect(green()).toBe("K");
  });

  it("shows the first word, unstarted, before anything is recording", () => {
    mount({ words: WORDS, elapsed: null });
    expect(text()).toBe("CQ");
    expect(green()).toBe("");
  });
});

