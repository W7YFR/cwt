/* Editing an upper-casing field anywhere but the end.
 *
 * Both message boxes transform what is typed into them, and on a controlled
 * input that is enough to break editing: React writes the transformed value
 * back, the browser treats the assignment as a fresh value and drops the caret
 * to the end, and inserting a character in the middle becomes impossible.
 *
 * It hides well, which is why it survived. Every character of "CQ CQ DE W1AW K"
 * is typed at the end, where a caret already at the end is where you wanted it
 * anyway. It only shows when correcting a call sign you have already typed —
 * which is exactly when somebody is most likely to be in a hurry.
 *
 * Driven through a stateful harness rather than a fixed prop, because the bug
 * is in the round trip: the value has to actually come back through React for
 * the caret to be lost.
 */

import { describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUpperField } from "@/ui/useUpperField";

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const field = useUpperField(setValue);
  return (
    <input
      aria-label="message"
      type="text"
      value={value}
      ref={field.ref}
      onChange={field.onChange}
    />
  );
}

const box = () => screen.getByLabelText("message") as HTMLInputElement;

describe("an upper-casing text field", () => {
  it("upper-cases what is typed", async () => {
    const user = userEvent.setup();
    render(<Harness initial="" />);
    await user.type(box(), "cq de w1aw");
    expect(box().value).toBe("CQ DE W1AW");
  });

  it("inserts in the middle without the caret jumping to the end", async () => {
    const user = userEvent.setup();
    render(<Harness initial="W1AW" />);
    // Put the caret between the 1 and the A, then type — the correction
    // somebody actually makes to a call sign they got wrong.
    await user.type(box(), "b", { initialSelectionStart: 2, initialSelectionEnd: 2 });

    expect(box().value).toBe("W1BAW");
    expect(box().selectionStart).toBe(3);
  });

  it("keeps its place across several characters in a row", async () => {
    const user = userEvent.setup();
    render(<Harness initial="CQ DE W1AW" />);
    await user.type(box(), "cq ", { initialSelectionStart: 3, initialSelectionEnd: 3 });

    expect(box().value).toBe("CQ CQ DE W1AW");
    expect(box().selectionStart).toBe(6);
  });

  it("still works at the end, which is where most typing happens", async () => {
    const user = userEvent.setup();
    render(<Harness initial="CQ DE" />);
    await user.type(box(), " w1aw");
    expect(box().value).toBe("CQ DE W1AW");
    expect(box().selectionStart).toBe(box().value.length);
  });

  it("deletes from the middle without jumping either", async () => {
    const user = userEvent.setup();
    render(<Harness initial="W1BAW" />);
    await user.type(box(), "{Backspace}", {
      initialSelectionStart: 3,
      initialSelectionEnd: 3,
    });
    expect(box().value).toBe("W1AW");
    expect(box().selectionStart).toBe(2);
  });
});
