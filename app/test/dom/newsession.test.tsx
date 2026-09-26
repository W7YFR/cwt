/* Starting a session on purpose.
 *
 * The alternative considered was a warning when the intended message changed
 * mid-session. This is better: a warning tells you that you might be doing the
 * wrong thing and then lets you do it anyway, whereas a way to say "new
 * session" is the right thing, named. So what matters here is that it collects
 * everything a session is — one message, one speed, one number of passes —
 * and hands it over in one act. Two acts, strictly: it also offers to open the
 * microphone on the way out, because the click after this dialog is almost
 * always the record button.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DRILLS } from "@/drills";
import { NewSession, oneLine } from "@/ui/NewSession";

function open(over: Partial<React.ComponentProps<typeof NewSession>> = {}) {
  const onStart = vi.fn();
  const onCancel = vi.fn();
  render(
    <NewSession
      expected="CQ DE W7YFR"
      charWpm={20}
      farnsworthWpm={20}
      times={1}
      onStart={onStart}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onStart, onCancel };
}

const text = () => screen.getByLabelText(/target message/i) as HTMLTextAreaElement;

describe("starting a new session", () => {
  it("opens on the message, which is why you came", () => {
    open();
    expect(document.activeElement).toBe(text());
  });

  it("hands over the message, both speeds and the pass count together", async () => {
    const user = userEvent.setup();
    const { onStart } = open();
    await user.clear(text());
    await user.type(text(), "paris paris");
    await user.click(screen.getByTestId("start-session"));
    expect(onStart).toHaveBeenCalledWith(
      { expected: "PARIS PARIS", charWpm: 20, farnsworthWpm: 20, times: 1 },
      false,
    );
  });

  it("offers to open the microphone on the same click", async () => {
    /* Saving and then reaching for the record button is two acts for one
       intention, and the second one is the same click every time. The dot
       collects the session and asks for the microphone together — same
       payload, so nothing about what the session IS can differ between the
       two ways out. */
    const user = userEvent.setup();
    const { onStart } = open({ expected: "CQ TEST", times: 2 });
    await user.click(screen.getByTestId("start-session-recording"));
    expect(onStart).toHaveBeenCalledWith(
      { expected: "CQ TEST", charWpm: 20, farnsworthWpm: 20, times: 2 },
      true,
    );
  });

  it("says which of the two it is, out loud", () => {
    /* One is a dot with no text in it. Screen-reader users get the whole
       choice or they get one button and a mystery. */
    open();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /save and record/i })).toBeTruthy();
  });

  it("takes Enter as saving, not as recording", async () => {
    /* Enter is how the speed boxes are left, and opening the microphone is
       not something to do by accident on the way out of a number field. */
    const user = userEvent.setup();
    const { onStart } = open();
    await user.click(screen.getByLabelText(/character speed/i));
    await user.keyboard("{Enter}");
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]![1]).toBe(false);
  });

  it("collects how many passes make up an attempt", async () => {
    /* Part of what a session is fixed at, like the speed: a stack whose rows
       are one pass and five passes is not comparable either. It opens at
       whatever the session before it ran, so the common case is to leave it
       alone. */
    const user = userEvent.setup();
    const { onStart } = open({ times: 3 });
    const box = screen.getByLabelText(/times/i) as HTMLInputElement;
    expect(box.value).toBe("3");
    await user.clear(box);
    await user.type(box, "5");
    await user.click(screen.getByTestId("start-session"));
    expect(onStart.mock.calls[0]![0].times).toBe(5);
  });

  it("hands over a pass count the rest of the app can use as a length", async () => {
    /* Emptying the box leaves nothing under the caret to parse, and a NaN
       reaching the target builder is an empty sheet rather than a short one. */
    const user = userEvent.setup();
    const { onStart } = open({ times: 3 });
    await user.clear(screen.getByLabelText(/times/i));
    await user.click(screen.getByTestId("start-session"));
    expect(onStart.mock.calls[0]![0].times).toBe(3);
  });

  it("shows the message the way it will be sent", async () => {
    /* Morse has one case, and the message is upper-cased on the way out
       regardless. A box showing something other than what it is about to hand
       over is a small lie, and small lies about the target are the ones that
       cost you a session. */
    const user = userEvent.setup();
    open({ expected: "cq de w7yfr" });
    expect(text().value).toBe("CQ DE W7YFR");
    await user.clear(text());
    await user.type(text(), "paris");
    expect(text().value).toBe("PARIS");
  });

  it("keeps your place while it does it", async () => {
    /* Upper-casing a controlled field writes the value back, which drops the
       caret to the end, so typing anywhere but the end becomes impossible.
       Here because the box has to be wired to the field that handles that and
       not merely upper-case on its own — the two look identical until you
       correct a call sign you already typed. */
    const user = userEvent.setup();
    open({ expected: "CQ W7YFR" });
    await user.type(text(), "de ", {
      initialSelectionStart: 3,
      initialSelectionEnd: 3,
    });
    expect(text().value).toBe("CQ DE W7YFR");
  });

  it("makes one message out of however it was pasted", () => {
    /* Practice text arrives from somewhere else, with newlines in it. */
    expect(oneLine("  cq  cq\n de   w7yfr \n")).toBe("CQ CQ DE W7YFR");
    expect(oneLine("")).toBe("");
  });

  it("keeps the overall speed from exceeding the character speed", async () => {
    /* Clamped rather than refused: a Farnsworth setting left over from the
       session before must not be able to block a start. */
    const user = userEvent.setup();
    const { onStart } = open({ charWpm: 13, farnsworthWpm: 20 });
    await user.click(screen.getByTestId("start-session"));
    expect(onStart.mock.calls[0]![0].farnsworthWpm).toBeLessThanOrEqual(13);
  });

  it("starts nothing when it is dismissed", async () => {
    const user = userEvent.setup();
    const { onStart, onCancel } = open();
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("takes Escape as dismissing it", async () => {
    const user = userEvent.setup();
    const { onStart, onCancel } = open();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("says what starting one costs", () => {
    /* It throws recordings away, and somebody reaching for it to change the
       speed should find that out before they click rather than after. */
    open();
    const dialog = screen.getByTestId("new-session");
    expect(dialog.textContent).toMatch(/cleared/i);
  });

  it("is a dialog, and says so", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog).toHaveAccessibleName(/new session/i);
  });

  describe("picking a drill", () => {
    const drill = DRILLS[1]!;

    it("fills the message and hands it over on Save", async () => {
      const user = userEvent.setup();
      const { onStart } = open();
      await user.click(screen.getByTestId("drill-picker"));
      await user.click(screen.getByTestId(`drill-option-${drill.id}`));
      expect(text().value).toBe(drill.text);
      expect(document.activeElement).toBe(text());
      expect(screen.queryByRole("tree")).toBeNull();
      await user.click(screen.getByTestId("start-session"));
      expect(onStart.mock.calls[0]![0].expected).toBe(drill.text);
    });

    it("takes Enter in the list as a pick, not a start", async () => {
      const user = userEvent.setup();
      const { onStart } = open();
      await user.click(screen.getByTestId("drill-picker"));
      await user.keyboard("{ArrowDown}{Enter}");
      expect(text().value).toBe(drill.text);
      expect(onStart).not.toHaveBeenCalled();
    });

    it("takes Enter on the button as opening the list, not a start", async () => {
      const user = userEvent.setup();
      const { onStart } = open();
      screen.getByTestId("drill-picker").focus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("tree")).toBeTruthy();
      expect(onStart).not.toHaveBeenCalled();
    });

    it("takes Escape in the list as closing the list only", async () => {
      const user = userEvent.setup();
      const { onCancel } = open();
      await user.click(screen.getByTestId("drill-picker"));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("tree")).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
      expect(text().value).toBe("CQ DE W7YFR");
    });

    it("jumps to a drill by its first letters", async () => {
      const user = userEvent.setup();
      open();
      await user.click(screen.getByTestId("drill-picker"));
      await user.keyboard("be{Enter}");
      expect(text().value).toBe("BENS BEST BENT WIRE/5");
    });

    it("collapses and expands a group from its header", async () => {
      const user = userEvent.setup();
      open();
      await user.click(screen.getByTestId("drill-picker"));
      const header = screen.getByTestId("drill-group-daily-sending");
      await user.click(header);
      expect(screen.queryByTestId(`drill-option-${drill.id}`)).toBeNull();
      expect(screen.getByRole("treeitem", { name: "Daily Sending" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await user.click(header);
      expect(screen.getByTestId(`drill-option-${drill.id}`)).toBeTruthy();
    });

    it("collapses with Left and expands with Right", async () => {
      const user = userEvent.setup();
      open();
      await user.click(screen.getByTestId("drill-picker"));
      // Left from a drill goes to its group; Left again collapses it.
      await user.keyboard("{ArrowLeft}{ArrowLeft}");
      expect(screen.queryByTestId(`drill-option-${drill.id}`)).toBeNull();
      // Enter on a group toggles it rather than starting anything.
      await user.keyboard("{Enter}");
      expect(screen.getByTestId(`drill-option-${drill.id}`)).toBeTruthy();
      await user.keyboard("{ArrowLeft}{ArrowRight}{ArrowRight}{ArrowDown}{Enter}");
      expect(text().value).toBe(drill.text);
    });

    it("moves the focus to the group when the group it is in collapses", async () => {
      const user = userEvent.setup();
      open();
      await user.click(screen.getByTestId("drill-picker"));
      await user.click(screen.getByTestId("drill-group-daily-sending"));
      const tree = screen.getByRole("tree");
      const group = screen.getByRole("treeitem", { name: "Daily Sending" });
      expect(tree.getAttribute("aria-activedescendant")).toBe(group.id);
    });

    it("groups the options under their section", async () => {
      const user = userEvent.setup();
      open();
      await user.click(screen.getByTestId("drill-picker"));
      const warm = screen.getByRole("group", { name: "Daily Sending › Warm Up" });
      expect(warm.querySelectorAll('[role="treeitem"]').length).toBe(4);
    });
  });
});
