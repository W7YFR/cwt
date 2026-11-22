/* The Live page's log as a file: the transcript as text.
 *
 * Pure.
 */

import type { Line, Qso } from "./log";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A time as UTC date and time: 2026-11-21 18:04:05. */
function utc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** The transcript, one turn a line: time, the radio's frequency when you
 *  noted it, pitch, sender, speed and text. */
export function transcriptText(lines: readonly Line[], qsos: readonly Qso[] = []): string {
  const freq = new Map(qsos.map((q) => [q.id, q.freq]));
  return lines
    .map((l) => {
      const who = l.sender ?? "?";
      const speed = l.turn.wpm ? ` ${l.turn.wpm} WPM` : "";
      const tuned = l.qso ? freq.get(l.qso) : null;
      return `${utc(l.turn.at)}Z  ${tuned ? `${tuned}  ` : ""}${l.turn.hz} Hz  ${who}${speed}  ${l.turn.text}`;
    })
    .join("\n")
    .concat(lines.length ? "\n" : "");
}
