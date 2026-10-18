/* A menu of the user-detail slots, and typing a pick in at the cursor. */

import { useLayoutEffect, useRef, type RefObject } from "react";
import { SLOTS, SLOT_LABELS, replaceNotes, type Slot } from "@/drills";
import type { UserInfo } from "@/io/storage";

export const SLOT_NAMES = Object.keys(SLOTS) as Slot[];

const isSlotName = (s: string): s is Slot => (SLOT_NAMES as string[]).includes(s);

/** The slot's value from `user`, or "" when it is not set. */
export const slotValue = (slot: Slot, user: UserInfo): string => user[SLOTS[slot]].trim();

/** Notes in brackets as their values from `user`, such as your call for
 *  "(your call)". A note for a value that is not set stays as it is. */
export const notesToValues = (text: string, user: UserInfo): string =>
  replaceNotes(text, (slots) => {
    const values = slots.map((s) => slotValue(s, user));
    return values.every(Boolean) ? values.join(" ") : null;
  });

/** "A", "A and B", "A, B and C". */
const listOf = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The notes in a text with no value in the user's details, and the fields
 *  that would fill them. */
export interface UnsetNotes {
  notes: readonly string[];
  fields: readonly string[];
}

/** The notes in `text` with no value in `user`, or null when every note has
 *  one. */
export function unsetNotes(text: string, user: UserInfo): UnsetNotes | null {
  const notes = new Set<string>();
  const fields = new Set<string>();
  replaceNotes(text, (slots, note) => {
    const unset = slots.filter((s) => !slotValue(s, user));
    if (unset.length) notes.add(note.toUpperCase());
    for (const s of unset) fields.add(SLOT_LABELS[s]);
    return null;
  });
  return notes.size ? { notes: [...notes], fields: [...fields] } : null;
}

/** Says which notes cannot be filled in. With `onConfigure`, a link opens
 *  the fields that fill them. */
export function UnsetNotesText(props: {
  unset: UnsetNotes;
  onConfigure?: (() => void) | undefined;
}): React.ReactElement {
  const where = "User in Configuration";
  return (
    <span className="unsetnotes">
      {listOf(props.unset.notes)} cannot be filled in. Set {listOf(props.unset.fields)} under{" "}
      {props.onConfigure ? (
        <button type="button" className="link" onClick={props.onConfigure}>
          {where}
        </button>
      ) : (
        where
      )}
      .
    </span>
  );
}

/** Either kind of text box. */
type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Replace the selection in a text box with `token`, then put the caret after
 *  it. The caret moves once React has written the new text. */
export function useInsertAtCursor<T extends TextField>(
  ref: RefObject<T | null>,
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

/** A paste that `convert` changes goes in at the cursor through `insert`, in
 *  upper case. Any other paste goes in as usual. */
export function onPasteConverted<T extends TextField = HTMLTextAreaElement>(
  convert: (text: string) => string,
  insert: (text: string) => void,
): React.ClipboardEventHandler<T> {
  return (e) => {
    const pasted = e.clipboardData.getData("text/plain");
    const converted = convert(pasted);
    if (converted === pasted) return;
    e.preventDefault();
    insert(converted.toUpperCase());
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
