/* Example QSOs for the help, worked by the script itself.
 *
 * Only your side is written here, for a made-up operator. The station's side
 * is what `answer` says to it, with every wording fixed to its first, so the
 * help can never show the station saying something it would not say. A test
 * works the same example.
 */

import { answer, newQso, type Qso } from "./cq";
import type { Station } from "./station";

export interface ExampleLine {
  /** Sent by you, or by the station. */
  readonly you: boolean;
  readonly text: string;
}

export interface Example {
  readonly title: string;
  readonly lines: readonly ExampleLine[];
}

/** The station in the example. */
export const EXAMPLE_STATION: Station = {
  call: "K4ABC",
  name: "JIM",
  qth: "ATLANTA GA",
  rst: "599",
  toneHz: 600,
};

/** You, in the example: made up, as the station is. */
export const EXAMPLE_YOU = { call: "KD9XYZ", name: "TOM", qth: "OMAHA NE" } as const;

/** Work your side through the script, and return both sides. */
function work(yours: readonly string[]): ExampleLine[] {
  const fixed = { rand: () => 0, hour: 20, length: "short" as const };
  let qso: Qso = { ...newQso(() => 0), them: EXAMPLE_STATION };
  const lines: ExampleLine[] = [];
  for (const text of yours) {
    lines.push({ you: true, text });
    const turn = answer(qso, text, fixed);
    if (turn.reply !== null) lines.push({ you: false, text: turn.reply });
    qso = turn.ended ? newQso(() => 0) : turn.qso;
  }
  return lines;
}

/** One short QSO, start to finish. */
export function examples(): Example[] {
  const { call, name, qth } = EXAMPLE_YOU;
  return [
    {
      title: "Example",
      lines: work([
        `CQ CQ DE ${call} K`,
        `K4ABC DE ${call} UR 579 NAME ${name} QTH ${qth} K`,
        "TNX JIM 73 SK",
      ]),
    },
  ];
}
