/* How the next take records: plainly, against a pacing cursor, or in Zen mode.
 *
 * One choice with three answers, held as the two settings it has always been
 * held as. The cursor and Zen mode cannot run together, so a single control
 * that picks one of them is the whole of the rule, with nothing left to clear
 * or bar. Their options stay in the settings panel.
 */

import type { ReviewSettings } from "@/types";

export type RecordMode = "plain" | "paced" | "zen";

export const RECORD_MODES: ReadonlyArray<{ value: RecordMode; label: string }> = [
  { value: "plain", label: "Plain" },
  { value: "paced", label: "Paced" },
  { value: "zen", label: "Zen" },
];

/** The mode the settings describe. Zen wins over a cursor left on from
 *  before the two were one choice. */
export function modeOf(s: Pick<ReviewSettings, "zenMode" | "paceCursor">): RecordMode {
  return s.zenMode ? "zen" : s.paceCursor ? "paced" : "plain";
}

/** The settings that pick `mode`. */
export function modePatch(mode: RecordMode): Pick<ReviewSettings, "zenMode" | "paceCursor"> {
  return { zenMode: mode === "zen", paceCursor: mode === "paced" };
}
