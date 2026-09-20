/* The microphone's side of the conversation, in order.
 *
 * `MicDebug` puts the current state on the screen, which is what you want on a
 * phone with no console. But the question left over is not a state, it is a
 * *sequence*: the permission sheet goes up, something is tapped, and what
 * matters is which of the browser's answers arrives first and whether the two
 * of them agree. A readout taken after the fact cannot show that, and the one
 * moment worth watching is over before there is anything to tap `re-read`
 * with.
 *
 * So: the same flag, `?micdebug`, and a line per event with the clock on it.
 * Off, this is a function that returns immediately — the app logs nothing in
 * ordinary use, which is the right default for it and the reason the console
 * looked empty when it was first attached.
 *
 * Not `console.error`, and not only because the tests fail on that: none of
 * these is a fault. They are a transcript.
 */

/** Whether the URL asked for the transcript.
 *
 * Read each time rather than cached at import. Vite replaces modules in place
 * while the page is open, so a value captured once belongs to whichever copy
 * of this file happened to load first — and this is a debugging aid being read
 * on a device that is being hot-updated as it is used. */
export function micDebugOn(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).has("micdebug");
}

/** One line of the transcript: the moment, the event, and whatever detail the
 *  caller has that is worth reading at 3am on a phone. */
export function micLog(event: string, detail?: unknown): void {
  if (!micDebugOn()) return;
  const at = typeof performance === "undefined" ? 0 : performance.now();
  const stamp = `${(at / 1000).toFixed(3)}s`;
  if (detail === undefined) console.info(`[mic ${stamp}] ${event}`);
  else console.info(`[mic ${stamp}] ${event}`, detail);
}

/** A device list, flattened to something readable in a console line.
 *
 * Empty strings are spelled rather than shown as gaps: "the label is missing"
 * and "the label is a space" look identical in a log and mean different
 * things, and the missing one is the whole subject here. */
export function describeInputs(devices: MediaDeviceInfo[]): string {
  const inputs = devices.filter((d) => d.kind === "audioinput");
  if (inputs.length === 0) return "(no audioinput entries)";
  return inputs
    .map((d) => `{id:${d.deviceId ? `${d.deviceId.slice(0, 8)}…` : "(empty)"} label:${d.label || "(empty)"}}`)
    .join(" ");
}
