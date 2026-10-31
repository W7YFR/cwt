/* New exchange on the Copy page: text of your own to copy, and who sends each
 * line of it. The dialog hands over the text as typed and the stations set by
 * hand; the page makes the script. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_USER, saveUser } from "@/io/storage";
import { CopyText } from "@/ui/CopyText";

function open(over: Partial<React.ComponentProps<typeof CopyText>> = {}) {
  const onStart = vi.fn();
  const onCancel = vi.fn();
  render(<CopyText text="" picks={[]} onStart={onStart} onCancel={onCancel} {...over} />);
  return { onStart, onCancel };
}

const box = () => screen.getByTestId("copy-text-box") as HTMLTextAreaElement;
const save = () => screen.getByTestId("copy-text-start") as HTMLButtonElement;
const rows = () => [...screen.queryByTestId("copy-text-lines")?.querySelectorAll("li") ?? []];
/** Who sends each line, as the rows show it. */
const stations = () => rows().map((r) => Number(r.getAttribute("data-station")));
/** The button for station `s` on row `i`. */
const toggle = (i: number, s: number) => rows()[i]!.querySelectorAll("button")[s] as HTMLButtonElement;

const QSO = "CQ CQ DE AC4BT K\n\nAC4BT DE W7YFR K\n\nW7YFR DE AC4BT HW?\n\nW7YFR DE AC4BT K\n\nNAME ROB";

beforeEach(() => {
  localStorage.clear();
  saveUser({ ...EMPTY_USER, callsign: "W7YFR", name: "Rob" });
});

describe("New exchange", () => {
  it("opens on the text, in upper case", () => {
    open({ text: "cq de w1aw" });
    expect(document.activeElement).toBe(box());
    expect(box().value).toBe("CQ DE W1AW");
  });

  it("is a dialog", () => {
    open();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("will not save with nothing to send", async () => {
    const user = userEvent.setup();
    const { onStart } = open();
    expect(save().disabled).toBe(true);
    await user.type(box(), "###");
    expect(save().disabled).toBe(true);
    await user.click(save());
    expect(onStart).not.toHaveBeenCalled();
  });

  it("hands over the text as typed, and no station set by hand", async () => {
    const user = userEvent.setup();
    const { onStart } = open({ text: QSO });
    await user.click(save());
    expect(onStart).toHaveBeenCalledWith({ text: QSO, picks: [null, null, null, null, null] });
  });

  it("starts nothing when it is dismissed, by Cancel or Escape", async () => {
    const user = userEvent.setup();
    const { onStart, onCancel } = open({ text: QSO });
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("takes Enter in the text as a line break, not a save", async () => {
    const user = userEvent.setup();
    const { onStart } = open({ text: "CQ" });
    await user.type(box(), "{End}{Enter}K");
    expect(box().value).toBe("CQ\nK");
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("who sends each line", () => {
  it("shows a row for each line to send, and none for blank lines", () => {
    open({ text: QSO });
    expect(rows()).toHaveLength(5);
  });

  it("shows no rows with nothing to send", () => {
    open();
    expect(rows()).toHaveLength(0);
  });

  it("guesses the station from DE and from the end of a turn", () => {
    open({ text: QSO });
    expect(stations()).toEqual([0, 1, 0, 0, 1]);
    expect(toggle(0, 0).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(1, 1).getAttribute("aria-pressed")).toBe("true");
  });

  it("names each station by its call once the text gives it", () => {
    open({ text: QSO });
    expect([toggle(0, 0).textContent, toggle(0, 1).textContent]).toEqual(["AC4BT", "W7YFR"]);
  });

  it("names a station by its number when the text gives no call", () => {
    open({ text: "UR RST 579 K\n\nTU" });
    expect([toggle(0, 0).textContent, toggle(0, 1).textContent]).toEqual(["1", "2"]);
  });

  it("names you by your call when a note in the text stands for it", () => {
    open({ text: "CQ DE (your call) K\n\nW1AW" });
    expect(toggle(0, 0).textContent).toBe("W7YFR");
  });

  it("hands over a station you set, and only that one", async () => {
    const user = userEvent.setup();
    const { onStart } = open({ text: QSO });
    await user.click(toggle(4, 0));
    expect(stations()).toEqual([0, 1, 0, 0, 0]);
    await user.click(save());
    expect(onStart.mock.calls[0]![0].picks).toEqual([null, null, null, null, 0]);
  });

  it("forgets a station set by hand when set back to the guess", async () => {
    const user = userEvent.setup();
    const { onStart } = open({ text: QSO });
    await user.click(toggle(4, 0));
    await user.click(toggle(4, 1));
    await user.click(save());
    expect(onStart.mock.calls[0]![0].picks).toEqual([null, null, null, null, null]);
  });

  it("goes back to the guess for a line whose text changes", async () => {
    const user = userEvent.setup();
    open({ text: "CQ DE W1AW K\n\nR R" });
    await user.click(toggle(1, 0));
    expect(stations()).toEqual([0, 0]);
    await user.type(box(), "{End} TU");
    expect(stations()).toEqual([0, 1]);
  });

  it("opens with the stations set before", () => {
    open({ text: QSO, picks: [null, 0, null, null, null] });
    expect(stations()).toEqual([0, 0, 0, 0, 1]);
  });

  it("takes a station set before only for the line it was set on", () => {
    open({ text: "CQ DE W1AW K\n\nR R", picks: [null, 0, 1] });
    expect(stations()).toEqual([0, 0]);
  });
});

describe("your details in the text", () => {
  it("fills a pasted note from your details", async () => {
    const user = userEvent.setup();
    open();
    box().focus();
    await user.paste("CQ DE (your call) K");
    expect(box().value).toBe("CQ DE W7YFR K");
  });

  it("warns of a note your details cannot fill", () => {
    saveUser({ ...EMPTY_USER });
    open({ text: "CQ DE (your call) K" });
    expect(screen.getByTestId("unset-notes")).toBeTruthy();
  });

  it("warns of symbols with no Morse", () => {
    open({ text: "CQ # K" });
    expect(screen.getByTestId("copy-text-unkeyable")).toBeTruthy();
  });

  it("inserts a detail at the cursor", async () => {
    const user = userEvent.setup();
    open({ text: "CQ DE  K" });
    box().setSelectionRange(6, 6);
    await user.selectOptions(screen.getByTestId("insert-slot"), "callsign");
    expect(box().value).toBe("CQ DE W7YFR K");
  });

  it("fills the text from a drill", async () => {
    const user = userEvent.setup();
    open({ text: "CQ" });
    await user.click(screen.getByTestId("drill-picker"));
    await user.click(screen.getByTestId("drill-option-qso/cq/1"));
    expect(box().value).toBe("CQ CQ CQ DE W7YFR W7YFR W7YFR K");
    expect(rows()).toHaveLength(1);
  });

  it("keeps typed text in upper case", () => {
    open();
    fireEvent.change(box(), { target: { value: "cq de w1aw" } });
    expect(box().value).toBe("CQ DE W1AW");
  });
});
