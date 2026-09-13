/* Good audio must keep decoding exactly as it does today.
 *
 * The work this guards is the opposite of what it asserts. Making the decoder
 * survive a microphone in a reverberant room means changing thresholding and
 * edge detection, and every one of those changes is capable of nudging a
 * boundary on a recording that was already perfect. A loopback capture is the
 * best input the app will ever see; improving the worst case at its expense is
 * not a trade worth making.
 *
 * So this compares the DSP against its own recorded answers with no tolerance
 * at all. See lock.ts for why exact equality is a reasonable thing to demand
 * of floating-point code, and for how to re-record when a change is intended.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CLEAN_WAVS, read, readSynth, type Reading } from "../lock";
import { oracleCasesFromDisk, DATA_DIR } from "../oracle-fs";
import { normalizePeak, readWav } from "../wav";

const LOCKFILE = resolve(DATA_DIR, "../..", "app/test/lock/clean-path.json");
const RECORDING = process.env.LOCK_RECORD === "1";

/* Collected at module scope so the case list exists before the lockfile does —
   a first run has to be able to record one. */
const SYNTH_CASES = oracleCasesFromDisk().filter((c) => c.synth);
const NAMES = [
  ...CLEAN_WAVS.map((w) => w.file.replace(/\.wav$/, "")),
  ...SYNTH_CASES.map((c) => c.name),
].sort((a, b) => a.localeCompare(b));

/** Every clean case, read fresh. */
function readAll(): Reading[] {
  const out: Reading[] = [];

  for (const w of CLEAN_WAVS) {
    const path = `${DATA_DIR}/${w.file}`;
    if (!existsSync(path)) continue;
    const wav = readWav(path);
    out.push(
      read(
        w.file.replace(/\.wav$/, ""),
        normalizePeak(wav.samples),
        wav.rate,
        w.expected,
        w.charWpm,
        w.farnsworthWpm,
      ),
    );
  }

  // The synthesized cases matter here because they are the only ones with no
  // recording noise at all — the cleanest input possible, and so the most
  // sensitive to a change in where an edge is found.
  for (const c of SYNTH_CASES) {
    const s = c.synth!;
    out.push(readSynth(c.name, s.text, s.wpm, s.farnsworthWpm, s.rate));
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function load(): Reading[] {
  return (JSON.parse(readFileSync(LOCKFILE, "utf8")) as { cases: Reading[] }).cases;
}

let fresh: Reading[] = [];

beforeAll(() => {
  fresh = readAll();
  if (RECORDING) {
    mkdirSync(dirname(LOCKFILE), { recursive: true });
    // One line per case. The segment arrays are long, and a diff that wraps is
    // a diff nobody reads.
    const body = fresh.map((r) => `  ${JSON.stringify(r)}`).join(",\n");
    writeFileSync(LOCKFILE, `{\n "cases": [\n${body}\n ]\n}\n`);
  }
});

describe("the clean path is locked", () => {
  it("has recorded answers to compare against", () => {
    expect(
      existsSync(LOCKFILE),
      `No lockfile at ${LOCKFILE}. Record one with ` +
        `LOCK_RECORD=1 npx vitest run --project pure clean-path`,
    ).toBe(true);
  });

  it("still covers every clean recording in the corpus", () => {
    // A case quietly dropped from the lock would look like a pass forever.
    expect(load().map((r) => r.name)).toEqual(NAMES);
    expect(fresh.map((r) => r.name)).toEqual(NAMES);
    // And the corpus has to contain the loopback capture, which is the whole
    // reason this file exists.
    expect(NAMES).toContain("cq-de-w7yfr-virtual");
  });

  it.each(CLEAN_WAVS.map((w) => w.file))("%s is present on disk", (file) => {
    // readAll() skips a missing WAV rather than failing, so without this a
    // deleted fixture would silently shrink the locked set.
    expect(existsSync(`${DATA_DIR}/${file}`)).toBe(true);
  });

  describe("every case decodes bit-identically", () => {
    it.each(NAMES)("%s", (name) => {
      const want = load().find((r) => r.name === name);
      const got = fresh.find((r) => r.name === name);
      expect(want, `${name} is not in the lockfile`).toBeDefined();
      expect(got, `${name} was not read this run`).toBeDefined();

      // Segments first and on their own, because everything below is derived
      // from them — if these move, the rest is noise.
      expect(got!.segments.length, "segment count").toBe(want!.segments.length);
      expect(got!.segments, "segment boundaries").toEqual(want!.segments);

      expect(got!.toneHz, "detected tone").toBe(want!.toneHz);
      expect(got!.threshold, "keying threshold").toBe(want!.threshold);
      expect(got!.text, "decoded text").toBe(want!.text);
      expect(got!.charWpm, "character speed").toBe(want!.charWpm);
      expect(got!.farnsworthWpm, "overall speed").toBe(want!.farnsworthWpm);
    });
  });
});
