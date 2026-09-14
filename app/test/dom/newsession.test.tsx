/* Starting a session on purpose.
 *
 * The alternative considered was a warning when the intended message changed
 * mid-session. This is better: a warning tells you that you might be doing the
 * wrong thing and then lets you do it anyway, whereas a way to say "new
 * session" is the right thing, named. So what matters here is that it collects
 * everything a session is — one message, one speed — and hands it over in one
 * act.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewSession, oneLine } from "@/ui/NewSession";

function open(over: Partial<React.ComponentProps<typeof NewSession>> = {}) {
  const onStart = vi.fn();
  const onCancel = vi.fn();
  render(
    <NewSession
      expected="CQ DE W7YFR"
      charWpm={20}
      farnsworthWpm={20}
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

  it("hands over the message and both speeds together", async () => {
    const user = userEvent.setup();
    const { onStart } = open();
    await user.clear(text());
    await user.type(text(), "paris paris");
    await user.click(screen.getByTestId("start-session"));
    expect(onStart).toHaveBeenCalledWith({
      expected: "PARIS PARIS",
      charWpm: 20,
      farnsworthWpm: 20,
    });
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
});
