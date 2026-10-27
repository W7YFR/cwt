/* A line to copy as slots: one box per character, in words. The slots say how
 * long each word is, so this is the easier way to copy.
 *
 * Typing fills a slot and moves to the next. Space goes to the next word, and
 * Backspace in an empty slot goes back one. Enter locks the line, where
 * the page takes `onLock`, and is the page's key where not. Escape leaves
 * it. On an attempt after the first, the slots you got right can stay
 * as they were. With `at`, the slot whose character is playing lights up.
 * With `grade`, a dot under each filled slot says if it is right.
 */

import { useRef } from "react";
import { CHAR_TO_MORSE } from "@/morse";
import { charsOf, slotRight, slotText, type LineCopy } from "@/copy/lines";
import type { Over } from "@/copy/decode";

/** Where a character is in the audio, for a selection or a click to play. */
function timeAttrs(c: { t0: number; t1: number }): Record<string, number> {
  return { "data-t0": c.t0, "data-t1": c.t1 };
}

/** The slot playing at `t`: from its character's start to the next
 *  character's start in the same word, or to its end at a word's end. */
function playingAt(over: Over, t: number | undefined): number {
  if (t === undefined) return -1;
  let i = 0;
  for (const w of over.words) {
    for (let k = 0; k < w.chars.length; k++, i++) {
      const c = w.chars[k]!;
      const until = w.chars[k + 1]?.t0 ?? c.t1;
      if (t >= c.t0 && t < until) return i;
    }
  }
  return -1;
}

/** The line's slots, open to type in. */
export function Slots({
  over,
  copy,
  label,
  at,
  grade = false,
  onSlots,
  onSelect,
  onLock,
  onKey,
}: {
  over: Over;
  copy: LineCopy;
  label: string;
  /** Where the audio is, to light up the slot playing. */
  at?: number | undefined;
  /** A dot under each filled slot, blue if right and red if not. */
  grade?: boolean;
  onSlots(slots: string[]): void;
  /** A slot is selected: its index in the line. */
  onSelect?(i: number): void;
  /** Enter locks the line. Without it, Enter goes on to the page. */
  onLock?(): void;
  /** Any key in a slot, before the slot handles it. */
  onKey?(): void;
}): React.ReactElement {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const chars = charsOf(over);
  const lit = playingAt(over, at);
  /** Where each word starts, by slot. */
  const starts: number[] = [];
  let n = 0;
  for (const w of over.words) {
    starts.push(n);
    n += w.chars.length;
  }
  const open = (i: number) => !copy.kept?.[i];
  const focus = (i: number | undefined) => {
    if (i === undefined) return;
    const el = refs.current[i];
    el?.focus();
    el?.select();
  };
  const nextOpen = (i: number) => {
    for (let k = i + 1; k < chars.length; k++) if (open(k)) return k;
    return undefined;
  };
  const prevOpen = (i: number) => {
    for (let k = i - 1; k >= 0; k--) if (open(k)) return k;
    return undefined;
  };
  const set = (i: number, v: string) => onSlots(copy.slots.map((s, k) => (k === i ? v : s)));

  const keyDown = (ev: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    onKey?.();
    // With Cmd or Ctrl, a key is the page's.
    if (ev.metaKey || ev.ctrlKey) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      ev.currentTarget.blur();
    } else if (ev.key === "Enter" && onLock) {
      ev.preventDefault();
      ev.stopPropagation();
      onLock?.();
    } else if (ev.key === "Backspace" && !ev.currentTarget.value) {
      ev.preventDefault();
      const p = prevOpen(i);
      if (p !== undefined) {
        set(p, "");
        focus(p);
      }
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      focus(prevOpen(i));
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      focus(nextOpen(i));
    } else if (ev.key === " ") {
      ev.preventDefault();
      // At the start of a word with nothing typed, this is the next word.
      if (starts.includes(i) && !ev.currentTarget.value) return;
      const word = starts.find((s) => s > i);
      if (word !== undefined) focus(open(word) ? word : nextOpen(word));
    }
  };

  let first = true;
  return (
    <span className="text slots" role="group" aria-label={`Your copy of ${label}`} data-testid="copy-slots">
      {over.words.map((w, wi) => (
        <span key={wi} className="slotword">
          {w.chars.map((c, ci) => {
            const i = starts[wi]! + ci;
            const want = slotText(c.char).length;
            const playing = i === lit ? " playing" : "";
            if (!open(i)) {
              return (
                <span key={ci} className={`slot kept cright${playing}`} {...timeAttrs(c)}>
                  {copy.slots[i]}
                </span>
              );
            }
            const autoFocus = first;
            first = false;
            const typed = copy.slots[i] ?? "";
            const mark = grade && typed ? (slotRight(c.char, typed) ? " cright" : " cwrong") : "";
            return (
              <span key={ci} className={`slotcell${mark}`}>
                <input
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  className={`slot${want > 1 ? " wide" : ""}${playing}`}
                  data-testid="copy-slot"
                  aria-label={`Character ${i + 1}`}
                  value={copy.slots[i] ?? ""}
                  autoFocus={autoFocus}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="characters"
                  onFocus={(e) => {
                    e.currentTarget.select();
                    onSelect?.(i);
                  }}
                  onKeyDown={(e) => keyDown(e, i)}
                  onChange={(e) => {
                    let v = e.target.value.toUpperCase().replace(/\s+/g, "");
                    if (v.length > want) v = v.slice(-want);
                    set(i, v);
                    if (v.length >= want) focus(nextOpen(i));
                  }}
                />
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

/** An earlier attempt at the line, in slots the size of the ones you type
 *  in, so each sits over its slot: what you typed, a dot under it, blue if
 *  right and red if not. */
export function SlotsPast({ over, copy }: { over: Over; copy: LineCopy }): React.ReactElement {
  let i = 0;
  return (
    <span className="text slots past" data-testid="copy-past-slots">
      {over.words.map((w, wi) => (
        <span key={wi} className="slotword">
          {w.chars.map((c, ci) => {
            const typed = copy.slots[i++] ?? "";
            const want = slotText(c.char).length;
            return (
              <span
                key={ci}
                className={`slot${want > 1 ? " wide" : ""} ${slotRight(c.char, typed) ? "cright" : "cwrong"}`}
              >
                {typed || " "}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

/** The line's slots, locked: what you typed in each, with a dot under it,
 *  blue if right and red if not. With `sent`, what was sent under each, as
 *  the graded copy shows it. */
export function SlotsLocked({
  over,
  copy,
  marks,
  sent,
  showCount = true,
}: {
  over: Over;
  copy: LineCopy;
  /** Dots under what you typed. */
  marks: boolean;
  sent: boolean;
  /** The count under it. Off where the page shows the score itself. */
  showCount?: boolean;
}): React.ReactElement {
  const chars = charsOf(over);
  const keyed = chars.filter((c) => c.char in CHAR_TO_MORSE).length;
  const right = chars.filter((c, i) => c.char in CHAR_TO_MORSE && slotRight(c.char, copy.slots[i] ?? "")).length;
  let i = 0;
  return (
    <span className="text graded" data-testid="copy-slots-locked">
      <span className="aligned">
        {over.words.map((w, wi) => (
          <span key={wi} className="cword">
            {w.chars.map((c, ci) => {
              const typed = copy.slots[i++] ?? "";
              const ok = slotRight(c.char, typed);
              return (
                <span key={ci} className="ccol">
                  <span className="yourcopy">
                    <span className={marks ? (ok ? "cright" : "cwrong") : undefined}>{typed || " "}</span>
                  </span>
                  {sent && (
                    <span className="sentcopy">
                      <span className={ok ? undefined : "cwrong"} {...timeAttrs(c)}>
                        {c.char}
                      </span>
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        ))}
      </span>
      {sent && showCount && (
        <span className="copied">
          {right} of {keyed} copied
        </span>
      )}
    </span>
  );
}

/** What was sent, each character where it is in the audio. With `upTo`,
 *  only the characters sent by then. */
export function SentText({ over, upTo }: { over: Over; upTo?: number }): React.ReactElement {
  const words = over.words
    .map((w) => w.chars.filter((c) => upTo === undefined || c.t1 <= upTo))
    .filter((w) => w.length > 0);
  return (
    <span className="text sent">
      {words.map((w, wi) => (
        <span key={wi}>
          {wi > 0 && " "}
          {w.map((c, ci) => (
            <span key={ci} {...timeAttrs(c)}>
              {c.char}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
