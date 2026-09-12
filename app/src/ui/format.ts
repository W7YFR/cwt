/* Readout formatting.
 *
 * Every number in the control row is padded to a constant width, and that is
 * not cosmetic. The groups are sized by their content and the intended-message
 * field absorbs the slack, so a reading that gains a digit drags the whole row
 * with it — the caption beside it wraps and unwraps as the number grows.
 * Dragging a slider made that twitch once; zooming with the wheel made it
 * constant. Monospace, tabular figures and `white-space: pre` in the CSS are
 * what make the padding land exactly.
 */

/** Right-align into a field `w` characters wide. */
export function pad(value: string | number, w: number): string {
  let s = String(value);
  while (s.length < w) s = ` ${s}`;
  return s;
}

/** Both speeds read 5-45, so two characters covers them. */
export function fmtWpm(v: number): string {
  return `${pad(Math.round(v), 2)} wpm`;
}

export function fmtTolerance(frac: number): string {
  return `${pad(Math.round(frac * 100), 2)}%`;
}

export function fmtGain(db: number): string {
  // Three characters: the widest reading is a signed two-digit boost.
  return `${pad((db > 0 ? "+" : "") + db, 3)} dB`;
}

/** The wheel lands on fractions; the slider can only say whole numbers, so the
 *  fraction is shown rather than rounded away behind your back. Four
 *  characters, which is "18.9" — the widest this can read. */
export function fmtPpu(v: number): string {
  return `${pad(v % 1 ? v.toFixed(1) : v, 4)} px/unit`;
}

export function fmtSeconds(t: number): string {
  return `${t.toFixed(1)}s`;
}

/** The running length of a recording, in a field that cannot change width.
 *
 * Five characters, which covers the recorder's own five-minute ceiling. Padded
 * rather than merely tabular because crossing 10.0s adds a digit, and an eight
 * pixel jump in the middle of a header is exactly the kind of twitch you
 * notice without being able to say what moved. */
export function fmtElapsed(seconds: number): string {
  return `${pad(seconds.toFixed(1), 5)}s`;
}

/** A filename stem from a source label, safe for a download. */
export function baseName(source: string): string {
  return (
    String(source || "cw-session")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w.-]+/g, "-") || "cw-session"
  );
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
