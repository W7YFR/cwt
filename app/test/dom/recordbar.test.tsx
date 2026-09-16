/* The bar above the chart.
 *
 * Narrow on purpose: what a session does lives in `session.test.tsx`, and what
 * the chart draws lives in the pure tier. What is left here is which controls
 * the bar itself carries — and, since Drop moved down to the scores, that the
 * two it keeps are the two that are about the whole session rather than about
 * one attempt in it.
 */

import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RecordBar } from "@/ui/Record";
import type { RecorderHandle } from "@/ui/useRecorder";
import type { Profile } from "@/io/profiles";

const IDLE: RecorderHandle = {
  devices: [],
  needPermission: false,
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
      deviceId={undefined}
      onDeviceChange={() => {}}
      profiles={[]}
      profileId={undefined}
      onProfileChange={() => {}}
      appliesToTake
      rereading={false}
      leadLeft={null}
      onClear={() => {}}
      {...over}
    />,
  );
}

/** A saved calibration, so the picker has something to offer. The numbers are
 *  not what is under test — only that a choice exists. */
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

  it("keeps clearing the whole session on its own button", () => {
    const onClear = vi.fn();
    bar({ onClear });
    screen.getByTestId("clear-take").click();
    expect(onClear).toHaveBeenCalled();
  });

  it("offers the calibration picker only when there is a calibration to pick", () => {
    /* One option is not a decision. Offering "No calibration" and nothing else
       is a control whose every state is the state it is already in. */
    const { rerender } = bar({ onCalibrate: () => {} });
    expect(screen.queryByLabelText(/^calibration$/i)).toBeNull();

    rerender(
      <RecordBar
        rec={IDLE}
        deviceId={undefined}
        onDeviceChange={() => {}}
        profiles={[PROFILE]}
        profileId={undefined}
        onProfileChange={() => {}}
        appliesToTake
        rereading={false}
        leadLeft={null}
        onCalibrate={() => {}}
      />,
    );
    expect(screen.getByLabelText(/^calibration$/i)).toBeTruthy();
  });

  it("puts the way into calibrating beside the picker that needs it", () => {
    /* The picker is where you find out you have nothing to pick. Without this
       the only ways in are the landing screen and the configuration screen,
       neither of which is where you are standing when you notice. */
    const onCalibrate = vi.fn();
    const { container } = bar({ onCalibrate, configuring: true });
    const button = screen.getByTestId("calibrate");
    // Inside the picker rather than out in the row of session actions: it is
    // about the control next to it, not about the session.
    expect(container.querySelector("[data-testid='calpick']")).toContainElement(button);
    button.click();
    expect(onCalibrate).toHaveBeenCalled();
  });

  it("keeps the setup behind the configuration it belongs to", () => {
    /* Which microphone, and what to correct it by. You cannot reach this
       screen without having answered the first, and the answer holds until
       something is unplugged — so in the row you work in, both are controls
       you use once and read past every time after. */
    const devices = [
      { deviceId: "a", label: "one" },
      { deviceId: "b", label: "two" },
    ];
    const rec = { ...IDLE, devices };
    bar({ rec, onCalibrate: () => {} });
    expect(screen.queryByLabelText(/input device/i)).toBeNull();
    expect(screen.queryByTestId("calibrate")).toBeNull();

    cleanup();
    bar({ rec, onCalibrate: () => {}, configuring: true });
    expect(screen.getByLabelText(/input device/i)).toBeInTheDocument();
    expect(screen.getByTestId("calibrate")).toBeInTheDocument();
  });

  it("does not offer calibrating against a recording that cannot use it", () => {
    // An opened file is read exactly as recorded — there is no picker there,
    // so there is nothing for the button to sit beside.
    bar({ onCalibrate: () => {}, appliesToTake: false });
    expect(screen.queryByTestId("calibrate")).toBeNull();
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
    expect(open.textContent?.trim()).toBe("↑");
    expect(record.textContent?.trim()).toBe("●");
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

