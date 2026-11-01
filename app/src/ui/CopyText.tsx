/* Script: a QSO of your own, pasted, typed, or opened from a .txt file.
 * On the Copy page, text to copy. On the QSO page, a QSO to work, with the
 * station you are.
 *
 * Built as the Send page's New session is: a box for the text, Insert for a
 * user detail, and a drill to start from. The page sends the text at its own
 * speed, as it sends a generated QSO.
 */

import { useEffect, useMemo, useState } from "react";
import { fillText, guessStations, linesOf, unkeyable } from "@/copy/text";
import { youIn } from "@/qso/script";
import { loadDrills } from "@/drills";
import { loadUser } from "@/io/storage";
import { breakLines } from "@/morse";
import { DrillPicker } from "./DrillPicker";
import {
  SlotMenu,
  notesToValues,
  onPasteConverted,
  slotValue,
  UnsetNotesText,
  unsetNotes,
  useInsertAtCursor,
} from "./SlotMenu";
import { useUpperField } from "./useUpperField";

/** A station set by hand, for the line at its place with its text. A line
 *  edited goes back to what the text says. */
const pickKey = (i: number, line: string) => `${i}|${line}`;

export interface CopyTextProps {
  /** The text the box starts with. */
  text: string;
  /** The station set for each line of `text`, or null where the text says. */
  picks: readonly (number | null)[];
  /** On the QSO page: which station you are, or null where the text says.
   *  Absent on the Copy page. */
  you?: 0 | 1 | null;
  /** With `you` only on the QSO page. */
  onStart(next: { text: string; picks: (number | null)[]; you?: 0 | 1 }): void;
  onCancel(): void;
  /** Close, and open the user's details in Configuration. */
  onConfigureUser?: (() => void) | undefined;
}

export function CopyText(props: CopyTextProps): React.ReactElement {
  const [text, setText] = useState(() => props.text.toUpperCase());
  const [picks, setPicks] = useState<ReadonlyMap<string, 0 | 1>>(() => {
    const m = new Map<string, 0 | 1>();
    linesOf(props.text).forEach((l, i) => {
      const p = props.picks[i];
      if (p === 0 || p === 1) m.set(pickKey(i, l), p);
    });
    return m;
  });
  const drills = useMemo(loadDrills, []);
  const user = useMemo(loadUser, []);
  const script = props.you !== undefined;
  const [youPick, setYouPick] = useState<0 | 1 | null>(props.you ?? null);
  const field = useUpperField<HTMLTextAreaElement>(setText);
  const box = field.ref;
  const insert = useInsertAtCursor(box, text, setText);
  // A pasted note such as "(your call)" goes in as its value.
  const paste = onPasteConverted((t) => notesToValues(t, user), insert);
  const unset = unsetNotes(text, user);
  const noMorse = unkeyable(text);
  const lines = linesOf(text);
  const empty = lines.length === 0;
  const guess = guessStations(lines);
  const stations = guess.stations.map((s, i) => picks.get(pickKey(i, lines[i]!)) ?? s);
  /** What a station is called: its call, once the text names it. */
  const callOf = (s: number) => {
    const call = fillText(guess.calls[s]!, user);
    return call && !call.includes("(") ? call : null;
  };
  const pick = (i: number, s: 0 | 1) => {
    const m = new Map(picks);
    const key = pickKey(i, lines[i]!);
    if (guess.stations[i] === s) m.delete(key);
    else m.set(key, s);
    setPicks(m);
  };

  useEffect(() => {
    box.current?.focus();
    box.current?.select();
  }, []);

  const you = youPick ?? youIn(text, user.callsign);
  const start = () => {
    if (empty) return;
    const chosen = lines.map((l, i) => picks.get(pickKey(i, l)) ?? null);
    props.onStart(script ? { text, picks: chosen, you } : { text, picks: chosen });
  };

  return (
    <div
      className="sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div
        className="dialog copytextdialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copytext-title"
        data-testid="copy-text"
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
          // In the box, Enter is a line break.
          if (e.key === "Enter" && e.target !== box.current) start();
        }}
      >
        <h2 id="copytext-title">Script</h2>
        <p className="hint">
          {script
            ? "Each line of text is a line of the QSO. You send your lines, and the station sends the rest. "
            : "Each line of text is a line to copy. "}
          A line with DE and a call is sent by that call. After K, KN, SK, a ? or E E, the other station sends. Notes
          such as (your call) fill in from your details.
        </p>

        <div className="fieldrow">
          <label htmlFor="ct-text">Text</label>
          <SlotMenu label="Insert" user={user} onPick={(slot) => insert(slotValue(slot, user))} />
          <DrillPicker
            drills={drills}
            onPick={(d) => {
              setText(breakLines(d.text));
              box.current?.focus();
            }}
          />
        </div>
        <textarea
          id="ct-text"
          ref={box}
          rows={12}
          spellCheck={false}
          value={text}
          placeholder={"CQ CQ DE (your call) K\n\n(your call) DE W1AW K"}
          onChange={field.onChange}
          onPaste={paste}
          data-testid="copy-text-box"
        />
        {unset && (
          <p className="hint warn" role="status" data-testid="unset-notes">
            <UnsetNotesText unset={unset} onConfigure={props.onConfigureUser} />
          </p>
        )}
        {noMorse.length > 0 && (
          <p className="hint warn" role="status" data-testid="copy-text-unkeyable">
            {noMorse.join(" ")} {noMorse.length === 1 ? "has" : "have"} no Morse and {noMorse.length === 1 ? "is" : "are"}{" "}
            left out.
          </p>
        )}

        {script && lines.length > 0 && (
          <div className="fieldrow">
            <span className="caption" id="ct-you-label">
              You are
            </span>
            <div className="modeswitch" role="group" aria-labelledby="ct-you-label" data-testid="copy-text-you">
              {([0, 1] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  aria-pressed={you === st}
                  title={`Station ${st + 1}${callOf(st) ? `, ${callOf(st)}` : ""}`}
                  onClick={() => setYouPick(st)}
                >
                  {callOf(st) ?? st + 1}
                </button>
              ))}
            </div>
          </div>
        )}

        {lines.length > 0 && (
          <>
            <div className="fieldrow">
              <span className="caption" id="ct-lines-label">
                Who sends each line
              </span>
            </div>
            <ol className="copyturns" aria-labelledby="ct-lines-label" data-testid="copy-text-lines">
              {lines.map((l, i) => (
                <li key={i} data-station={stations[i]}>
                  <div className="modeswitch" role="group" aria-label={`Station of line ${i + 1}`}>
                    {([0, 1] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        aria-pressed={stations[i] === st}
                        title={`Station ${st + 1}${callOf(st) ? `, ${callOf(st)}` : ""}`}
                        onClick={() => pick(i, st)}
                      >
                        {callOf(st) ?? st + 1}
                      </button>
                    ))}
                  </div>
                  <span className="turntext">{l}</span>
                </li>
              ))}
            </ol>
          </>
        )}

        <div className="confirm">
          <button onClick={props.onCancel}>Cancel</button>
          <button data-testid="copy-text-start" disabled={empty} onClick={start}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
