/* A menu of the user-detail slots, and typing a pick in at the cursor. */

import { useLayoutEffect, useRef, type RefObject } from "react";
import { SLOTS, SLOT_LABELS, type Slot } from "@/drills";
import type { UserInfo } from "@/io/storage";

export const SLOT_NAMES = Object.keys(SLOTS) as Slot[];

const isSlotName = (s: string): s is Slot => (SLOT_NAMES as string[]).includes(s);

/** The slot's value from `user`, or "" when it is not set. */
export const slotValue = (slot: Slot, user: UserInfo): string => user[SLOTS[slot]].trim();

/** Replace the selection in a text box with `token`, then put the caret after
 *  it. The caret moves once React has written the new text. */
export function useInsertAtCursor(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  setText: (text: string) => void,
): (token: string) => void {
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const at = caret.current;
    caret.current = null;
    if (el && at !== null) {
      el.focus();
      el.setSelectionRange(at, at);
    }
  });

  return (token: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + token + text.slice(end));
    caret.current = start + token.length;
  };
}

/** Always reads its label. A pick calls `onPick`, then the menu resets.
 *
 * With `user`, each option shows the slot's value, and a slot with no value
 * cannot be picked. */
export function SlotMenu(props: {
  onPick(slot: Slot): void;
  user?: UserInfo;
  /** What the closed menu reads. */
  label?: string;
}): React.ReactElement {
  const { user, label = "Insert slot" } = props;
  return (
    <select
      className="slotmenu"
      data-testid="insert-slot"
      aria-label={label}
      // A select is as wide as its widest option. This one fits its label and
      // the chevron. The open list still shows each option in full.
      style={{ width: `calc(${label.length}ch + 40px)` }}
      value=""
      // Enter picks here. It must not reach a dialog that submits on Enter.
      onKeyDown={(e) => {
        if (e.key === "Enter") e.stopPropagation();
      }}
      onChange={(e) => {
        const slot = e.target.value;
        if (isSlotName(slot)) props.onPick(slot);
      }}
    >
      <option value="" disabled>
        {label}
      </option>
      {SLOT_NAMES.map((slot) => {
        const value = user ? slotValue(slot, user) : null;
        return (
          <option key={slot} value={slot} disabled={value === ""}>
            {value === null
              ? `{${slot}} · ${SLOT_LABELS[slot]}`
              : `${SLOT_LABELS[slot]} · ${value || "not set"}`}
          </option>
        );
      })}
    </select>
  );
}
