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
import { RecordBar } from "@/ui/Record";
import type { RecorderHandle } from "@/ui/useRecorder";

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

