/* The bar above the chart.
 *
 * Narrow on purpose: what a session does lives in `session.test.tsx`, and what
 * the chart draws lives in the pure tier. What is left here is which controls
 * the bar itself carries — and, since Drop moved down to the scores, that the
 * two it keeps are the two that are about the whole session rather than about
 * one attempt in it.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DRILLS } from "@/drills";
import { RecordBar } from "@/ui/Record";
import { modeOf, modePatch } from "@/ui/mode";
import type { RecorderHandle } from "@/ui/useRecorder";

const IDLE: RecorderHandle = {
  devices: [],
  probing: false,
  needAccess: false,
  blocked: false,
  grantAccess: async () => {},
  recorder: null,
  elapsed: 0,
  level: 0,
  busy: false,
  start: async () => {},
  restart: () => {},
  finish: async () => {},
  discard: async () => {},
};

function bar(over: Partial<React.ComponentProps<typeof RecordBar>> = {}) {
  return render(
    <RecordBar
      rec={IDLE}
      appliesToTake
      leadLeft={null}
      onClear={() => {}}
      {...over}
    />,
  );
}

/* The one button on this bar that needs a microphone, and the three things it
   can mean. The split between asking and recording is in what the click does,
   and the landing screen no longer asks first — so this is where a first
   visit meets the question. */
describe("the record button and the state of the microphone", () => {
  it("records, once there is a microphone to record from", () => {
    const start = vi.fn();
    bar({ rec: { ...IDLE, start } });
    const button = screen.getByTestId("record-another");
    expect(button).toBeEnabled();
    button.click();
    expect(start).toHaveBeenCalled();
  });

  it("asks for access first rather than recording blind", () => {
    const start = vi.fn();
    const grantAccess = vi.fn();
    bar({ rec: { ...IDLE, needAccess: true, start, grantAccess } });
    const button = screen.getByTestId("record-another");
    // Live, because there is something useful behind it.
    expect(button).toBeEnabled();
    // In words, not only in a tooltip: a red dot promises a recording.
    expect(button).toHaveTextContent(/allow microphone/i);
    button.click();
    /* The whole point: a take started here would come from whatever the
       default input happens to be, chosen by nobody. */
    expect(grantAccess).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("is barred, and says why, when the browser has blocked the microphone", () => {
    const start = vi.fn();
    const grantAccess = vi.fn();
    bar({ rec: { ...IDLE, blocked: true, start, grantAccess } });
    const button = screen.getByTestId("record-another");
    /* Nothing on the page can lift a block, so a live button would open a
       prompt the browser never shows and read as broken. */
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toMatch(/settings/i);
    expect(button.getAttribute("aria-label")).toMatch(/blocked/i);
    button.click();
    expect(start).not.toHaveBeenCalled();
    expect(grantAccess).not.toHaveBeenCalled();
  });
});

describe("the record bar in a session", () => {
  it("offers a new session, which is a different act from clearing", () => {
    /* Clear keeps the message and the speeds and drops the recordings; a new
       session is where those change. Two buttons because they are two
       questions, and the one that throws more away says so in its dialog. */
    const onNewSession = vi.fn();
    bar({ onNewSession });
    screen.getByTestId("new-session-open").click();
    expect(onNewSession).toHaveBeenCalled();
  });

  it("starts a session at a picked drill", async () => {
    const user = userEvent.setup();
    const onDrill = vi.fn();
    bar({ onDrill });
    await user.click(screen.getByTestId("drill-picker"));
    await user.click(screen.getByTestId(`drill-option-${DRILLS[2]!.id}`));
    expect(onDrill).toHaveBeenCalledWith(DRILLS[2]);
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("keeps the list's keys from reaching the page's shortcuts", async () => {
    /* R records and T plays the target from anywhere on the page. Typed into
       the list, they are a search. */
    const user = userEvent.setup();
    const onKey = vi.fn();
    document.addEventListener("keydown", onKey);
    bar({ onDrill: () => {} });
    await user.click(screen.getByTestId("drill-picker"));
    await user.keyboard("rt ");
    document.removeEventListener("keydown", onKey);
    expect(onKey).not.toHaveBeenCalled();
  });

  it("keeps clearing the whole session on its own button", () => {
    const onClear = vi.fn();
    bar({ onClear });
    screen.getByTestId("clear-take").click();
    expect(onClear).toHaveBeenCalled();
  });

  it("leaves the setup to the settings panel", () => {
    /* Which microphone and what to correct it by are set once and left alone.
       They live in the panel's Audio group; the bar is for the session. */
    const devices = [
      { deviceId: "a", label: "one" },
      { deviceId: "b", label: "two" },
    ];
    bar({ rec: { ...IDLE, devices } });
    expect(screen.queryByLabelText(/input device|microphone/i)).toBeNull();
    expect(screen.queryByLabelText(/^calibration$/i)).toBeNull();
    expect(screen.queryByTestId("calibrate")).toBeNull();
  });

  it("still says a file is read exactly as recorded", () => {
    bar({ appliesToTake: false, source: "a.wav" });
    expect(screen.getByTestId("calchip")).toHaveTextContent(/read exactly as recorded/i);
  });
});

/* Opening a file from the bar.
 *
 * The drop target was already the whole window, but it says nothing about
 * itself until something is being dragged over it — so on its own it is a
 * feature you have to already know about. The asymmetry is the bug: one way in
 * had a button and the other did not.
 */
describe("opening a recording from the bar", () => {
  it("offers a way in that does not require knowing about dropping", () => {
    bar({ onFile: () => {} });
    expect(screen.getByTestId("open-file")).toBeEnabled();
  });

  it("comes before recording, and neither carries a word", () => {
    /* Icons, and in that order: opening a file is the rarer of the two ways
       in, so it reads as the smaller sibling rather than a competing
       headline. */
    bar({ onFile: () => {} });
    const open = screen.getByTestId("open-file");
    const record = screen.getByRole("button", { name: /record another/i });
    /* Drawn rather than typed, so the assertion is on which icon is there.
       And still no word on either: the icon is the whole of the button. */
    expect(open.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("upload");
    expect(record.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("record");
    expect(open.textContent?.trim()).toBe("");
    expect(record.textContent?.trim()).toBe("");
    // Named for anyone who cannot see the icon.
    expect(open).toHaveAccessibleName(/open a recording/i);
    expect(record).toHaveAccessibleName(/record/i);
    expect(open.compareDocumentPosition(record) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it("closes once the session has something in it", () => {
    /* A recording carries its own speed and only the attempt that starts a
       session gets to set one, so a file can begin a session but never join
       one. */
    bar({ onFile: () => {}, canOpenFile: false });
    expect(screen.getByTestId("open-file")).toBeDisabled();
  });

  it("says why it is closed, where a disabled button usually says nothing", () => {
    bar({ onFile: () => {}, canOpenFile: false });
    const title = screen.getByTestId("open-file").getAttribute("title") ?? "";
    expect(title).toMatch(/speed/i);
    // And what to do about it, rather than only what is wrong.
    expect(title).toMatch(/clear|new session/i);
  });

  it("stays out of the bar entirely when there is nowhere to send a file", () => {
    bar();
    expect(screen.queryByTestId("open-file")).toBeNull();
  });
});


/* Plain, Paced or Zen, beside the button that records. One control for one
   choice: the cursor and Zen mode cannot run together, so picking one is the
   whole of the rule. */
describe("the recording mode", () => {
  it("shows the mode in force, and picks another", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    bar({ mode: "paced", onMode });
    const group = screen.getByRole("group", { name: /recording mode/i });
    const pressed = [...group.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    expect(pressed.map((b) => b.textContent)).toEqual(["Paced"]);
    await user.click(screen.getByRole("button", { name: "Zen" }));
    expect(onMode).toHaveBeenCalledWith("zen");
  });

  it("is the two settings it has always been", () => {
    expect(modeOf({ zenMode: false, paceCursor: false })).toBe("plain");
    expect(modeOf({ zenMode: false, paceCursor: true })).toBe("paced");
    expect(modeOf({ zenMode: true, paceCursor: false })).toBe("zen");
    // Zen wins over a cursor saved from before the two were one choice.
    expect(modeOf({ zenMode: true, paceCursor: true })).toBe("zen");
    for (const m of ["plain", "paced", "zen"] as const) {
      expect(modeOf(modePatch(m))).toBe(m);
    }
    expect(modePatch("zen")).toEqual({ zenMode: true, paceCursor: false });
  });
});
