/* A text field that upper-cases what you type without throwing away your place.
 *
 * Call signs and Morse text are conventionally upper case, so both fields that
 * take a message transform what is typed into them. On a controlled input that
 * is enough to break editing: React writes the transformed value back into the
 * DOM node, the browser treats an assignment to `value` as a fresh value and
 * drops the caret to the end, and inserting a character anywhere but the end
 * becomes impossible. Typing at the end hides it completely, which is why it
 * survives casual use — every character of "CQ DE W1AW" goes in at the end.
 *
 * The fix is to put the caret back before the browser paints. `useLayoutEffect`
 * rather than `useEffect` for exactly that reason: after paint, the caret would
 * visibly jump to the end and back on every keystroke.
 *
 * Nothing is restored unless the transform left the length alone. Upper-casing
 * is one-to-one for anything a call sign contains, but not in general — "ß"
 * becomes "SS" — and an index measured against the typed string means nothing
 * once the transformed one is a different length.
 */

import { useCallback, useLayoutEffect, useRef } from "react";

interface Caret {
  readonly at: number;
  /** Length of the value as typed, before transforming. */
  readonly len: number;
}

export interface UpperField {
  ref: React.RefObject<HTMLInputElement | null>;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
}

export function useUpperField(onChange: (next: string) => void): UpperField {
  const ref = useRef<HTMLInputElement | null>(null);
  const caret = useRef<Caret | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const want = caret.current;
    // Consumed whether or not it can be used: a stale position restored on a
    // later, unrelated render would be its own bug.
    caret.current = null;
    if (!el || !want) return;
    if (el.value.length !== want.len) return;
    if (el.selectionStart === want.at && el.selectionEnd === want.at) return;
    el.setSelectionRange(want.at, want.at);
  });

  const handle = useCallback<React.ChangeEventHandler<HTMLInputElement>>(
    (e) => {
      caret.current = { at: e.target.selectionStart ?? 0, len: e.target.value.length };
      onChange(e.target.value.toUpperCase());
    },
    [onChange],
  );

  return { ref, onChange: handle };
}
