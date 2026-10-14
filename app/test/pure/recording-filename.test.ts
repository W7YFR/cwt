/* A saved calibration recording is named after the calibration it was saved
 * as, so the file and the calibration match up. */

import { describe, expect, it } from "vitest";
import { fileSlug, recordingFilename } from "@/ui/Settings";

describe("a calibration recording's filename", () => {
  const r = { id: "cal-20261014024141", wpm: 25 };

  it("leads with the calibration's name", () => {
    expect(recordingFilename(r, "Samson + K3NG")).toBe(
      "samson-k3ng-cal-20261014024141-25wpm.wav",
    );
  });

  it("keeps the old name when it was never saved as one", () => {
    expect(recordingFilename(r, undefined)).toBe("cal-20261014024141-25wpm.wav");
  });

  it("drops a name with nothing filename-safe in it", () => {
    expect(fileSlug("“ ” !")).toBe("");
    expect(recordingFilename(r, "!!")).toBe("cal-20261014024141-25wpm.wav");
  });
});
