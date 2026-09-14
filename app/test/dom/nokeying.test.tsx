/* What the page says when the recording has nothing in it.
 *
 * The measurement that decides this is tested in the pure tier; what is left
 * to prove is that the answer reaches the person who made the recording, and
 * reaches them as an explanation rather than as a fault. Opening a recording
 * of a quiet room is not a failure of anything — the file opened and the audio
 * decoded — so the page must not hand back the generic "something went wrong"
 * text it uses for a file it could not read.
 *
 * The fixture is a real recording of a real empty room rather than digital
 * silence, and deliberately so: a room has a refrigerator and a fan in it, and
 * this is the recording that comes back as a hundred and seventy-eight
 * elements of invented keying when nothing is willing to say there is nothing
 * here. Silence made of zeros would prove much less.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "@/ui/App";
import { DATA_DIR } from "../oracle-fs";
import { readWav } from "../wav";

const loadAudioFile = vi.fn();
vi.mock("@/capture/file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/capture/file")>()),
  loadAudioFile: (...args: unknown[]) => loadAudioFile(...args),
}));

const QUIET_ROOM = `${DATA_DIR}/k3ng/silence/webcam-silence.wav`;
const HAVE = existsSync(QUIET_ROOM);

function drop(file = new File(["RIFF"], "take.wav", { type: "audio/wav" })) {
  fireEvent.drop(window, {
    dataTransfer: { types: ["Files"], files: [file], dropEffect: "" },
  });
}

beforeEach(() => {
  if (HAVE) {
    const wav = readWav(QUIET_ROOM);
    /* The real peak, not a stand-in for one. The DSP is handed a copy scaled
       by it, so a quiet recording claiming a peak of 1 would reach the decoder
       at a thousandth of the level it really arrives at — a different question
       from the one this test is asking. */
    let peak = 0;
    for (const v of wav.samples) peak = Math.max(peak, Math.abs(v));
    loadAudioFile.mockResolvedValue({
      clip: { samples: wav.samples, rate: wav.rate, peak },
      name: "quiet-room.wav",
      data: new ArrayBuffer(8),
    });
  }
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!HAVE)("a recording with no keying in it", () => {
  it("says so, and says what to check", async () => {
    render(<App />);
    drop();

    /* Which kind of thing the banner is reporting, not what it says about it.
       Nothing keyed is its own answer and not a failure, so it must not get
       the text for a file that could not be read at all. */
    const banner = await screen.findByRole("alert");
    expect(banner.dataset.kind).toBe("no-keying");
    expect(banner.textContent!.length).toBeGreaterThan(20);
  });

  it("stays on the landing screen rather than opening an empty review", async () => {
    render(<App />);
    drop();

    await screen.findByRole("alert");
    /* A review of nothing would be a page of zeros wearing a grade, so the
       check is for the review's own furniture — its download buttons, which
       exist on no other screen. */
    await waitFor(() => {
      expect(screen.queryByText(/Your audio/i)).toBeNull();
    });
    expect(screen.queryByText(/JSON report/i)).toBeNull();
  });
});
