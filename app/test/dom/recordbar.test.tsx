/* The bar above the chart, in a session with several attempts in it.
 *
 * Narrow on purpose: what a session does lives in `session.test.tsx`, and what
 * the chart draws lives in the pure tier. This asks the one question neither
 * can — whether the controls for throwing an attempt away are on screen when
 * there is something to throw away, and absent when there is not.
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
  it("offers no way to drop a run when there is only one", () => {
    /* Dropping the only attempt and clearing the session are the same act, and
       two buttons for one question is one too many. */
    bar({ onDropRun: () => {}, runOf: { at: 0, of: 1 } });
    expect(screen.queryByTestId("drop-run")).toBeNull();
    expect(screen.getByTestId("clear-take")).toBeTruthy();
  });

  it("offers to drop the attempt being read, once there are others", () => {
    const onDropRun = vi.fn();
    bar({ onDropRun, runOf: { at: 2, of: 4 } });
    const button = screen.getByTestId("drop-run");
    // Named by the run it will throw away, counted the way the chart counts.
    expect(button.textContent).toContain("3");
    button.click();
    expect(onDropRun).toHaveBeenCalled();
  });

  it("keeps clearing the whole session on its own button", () => {
    const onClear = vi.fn();
    bar({ onClear, onDropRun: () => {}, runOf: { at: 0, of: 3 } });
    screen.getByTestId("clear-take").click();
    expect(onClear).toHaveBeenCalled();
  });
});
