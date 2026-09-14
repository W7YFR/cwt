/* A session: several attempts at one message.
 *
 * The loop this exists for is record, look, record again — so what matters is
 * that a second recording joins the first rather than replacing it, that the
 * target survives being recorded against twice, and that one bad attempt can
 * be thrown away without taking the session with it.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTake } from "@/ui/useTake";
import { MIC_SOURCE } from "@/io/take";
import { loadPrefs } from "@/io/storage";
import { caseNamed, CLEAN, SLOPPY } from "../fixture";
import { oracleSegments } from "../oracle";
import type { AudioClip } from "@/types";

/** Audio that decodes to something. The fixtures carry segments rather than
 *  samples, so this is a clip the analyzer will find marks in. */
function clipOf(name: string): AudioClip {
  const segs = oracleSegments(caseNamed(name));
  const rate = 8000;
  const total = segs.reduce((a, s) => a + s[1], 0);
  const samples = new Float32Array(Math.ceil(total * rate));
  let at = 0;
  for (const [on, sec] of segs) {
    const n = Math.round(sec * rate);
    if (on) {
      for (let i = 0; i < n && at + i < samples.length; i++) {
        samples[at + i] = Math.sin((2 * Math.PI * 600 * i) / rate);
      }
    }
    at += n;
  }
  return { samples, rate, peak: 1 };
}

const record = (result: { current: ReturnType<typeof useTake> }, name: string, id: string) =>
  act(() => result.current.load(clipOf(name), { source: MIC_SOURCE, id }));

beforeEach(() => localStorage.clear());

describe("a practice session", () => {
  it("stacks a second recording rather than replacing the first", () => {
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    expect(result.current.runs).toHaveLength(1);

    record(result, CLEAN, "r2");
    expect(result.current.runs).toHaveLength(2);
    // And lands on the one just recorded, which is the one you want to see.
    expect(result.current.selected).toBe(1);
  });

  it("keeps the target fixed once the session has one", () => {
    /* The failure this prevents: run 2 arriving with its own idea of what was
       being sent, replacing the target halfway through and re-grading
       everything already on screen against it. */
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    act(() => result.current.setSettings({ expected: "CQ DE W7YFR" }));
    const target = result.current.settings.expected;

    record(result, CLEAN, "r2");
    expect(result.current.settings.expected).toBe(target);
  });

  it("grades every attempt against that one target", () => {
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    act(() => result.current.setSettings({ expected: "CQ DE W7YFR" }));
    record(result, CLEAN, "r2");

    expect(result.current.reviews).toHaveLength(2);
    const targets = result.current.reviews.map((r) => r.ideal.chars.map((c) => c.char).join(""));
    expect(targets[0]).toBe(targets[1]);
  });

  it("reads whichever attempt is picked", () => {
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    record(result, CLEAN, "r2");

    act(() => result.current.selectRun(0));
    expect(result.current.selected).toBe(0);
    expect(result.current.loaded!.take.id).toBe(result.current.runs[0]!.take.id);
    expect(result.current.review).toBe(result.current.reviews[0]);
  });

  it("drops one attempt and keeps the rest", () => {
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    record(result, CLEAN, "r2");
    const keeping = result.current.runs[0]!.take.id;

    act(() => result.current.dropRun(1));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0]!.take.id).toBe(keeping);
    // Whatever is left has to be what is being read, or the report below the
    // chart would be about an attempt that is no longer there.
    expect(result.current.loaded!.take.id).toBe(keeping);
    expect(result.current.review).not.toBeNull();
  });

  it("keeps reading something when the attempt dropped was an earlier one", () => {
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    record(result, CLEAN, "r2");
    const last = result.current.runs[1]!.take.id;

    act(() => result.current.dropRun(0));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.loaded!.take.id).toBe(last);
  });

  it("starts over when the whole session is cleared", () => {
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    record(result, CLEAN, "r2");

    act(() => result.current.reset());
    expect(result.current.runs).toHaveLength(1);
    // One empty attempt to record into, not a screen with nothing on it.
    expect(result.current.runs[0]!.take.segments).toHaveLength(0);
  });

  it("does not count the empty attempt as a run to stack onto", () => {
    /* A cleared session holds one blank take so the chart has a row to draw.
       The next recording has to take its place rather than pile on top of it. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.reset());
    record(result, SLOPPY, "r1");
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0]!.take.segments.length).toBeGreaterThan(0);
  });
});

describe("coming back to a session", () => {
  it("writes down the order and which attempt was being read", () => {
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    record(result, CLEAN, "r2");
    act(() => result.current.selectRun(0));

    const saved = loadPrefs().session!;
    expect(saved.ids).toEqual(result.current.runs.map((r) => r.take.id));
    expect(saved.selected).toBe(0);
  });

  it("does not wipe it on the way up", () => {
    /* The bug this exists for: the effect that records the session also ran on
       the very first render, with nothing loaded — and it runs before the one
       that restores. Clearing on an empty list wiped the thing about to be
       restored, so every reload lost the stack and looked like the recording
       had failed rather than the bookkeeping. */
    const first = renderHook(() => useTake());
    record(first.result, SLOPPY, "r1");
    record(first.result, CLEAN, "r2");
    const wanted = loadPrefs().session!;
    first.unmount();

    // A fresh page: the hook mounts with nothing in it, as it would on boot.
    renderHook(() => useTake());
    expect(loadPrefs().session).toEqual(wanted);
  });

  it("opens every attempt again, reading the one that was being read", () => {
    const first = renderHook(() => useTake());
    record(first.result, SLOPPY, "r1");
    record(first.result, CLEAN, "r2");
    act(() => first.result.current.setSettings({ expected: "CQ DE W7YFR" }));
    const ids = first.result.current.runs.map((r) => r.take.id);
    const takes = first.result.current.runs.map((r) => r.take);
    first.unmount();

    const back = renderHook(() => useTake());
    act(() =>
      back.result.current.adoptSession(
        takes.map((take) => ({ take, audio: new ArrayBuffer(0) })),
        0,
      ),
    );
    expect(back.result.current.runs.map((r) => r.take.id)).toEqual(ids);
    expect(back.result.current.selected).toBe(0);
    expect(back.result.current.reviews).toHaveLength(2);
  });

  it("carries the session's settings back rather than rebuilding them", () => {
    /* The intended message is the one thing every attempt shares, and it lives
       in the settings rather than on any one take. Rebuilding from a take
       would drop it and re-grade the session against its own decode. */
    const { result } = renderHook(() => useTake());
    record(result, SLOPPY, "r1");
    const take = result.current.runs[0]!.take;
    const settings = { ...result.current.settings, expected: "PARIS PARIS" };

    act(() => result.current.adoptSession([{ take, audio: new ArrayBuffer(0), settings }], 0));
    expect(result.current.settings.expected).toBe("PARIS PARIS");
  });
});

describe("the speed a session declares", () => {
  it("survives the first recording", () => {
    /* A session is several attempts at one message at ONE speed — that is what
       makes its rows comparable. Declaring 25/12 and then having the first
       recording replace the overall speed with whatever it measured means the
       figure you set is not the figure you are graded against, and the "wpm
       overall (target N)" reading is quietly comparing you to yourself. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.reset({ charWpm: 25, farnsworthWpm: 12 }));
    expect(result.current.settings.farnsworthWpm).toBe(12);

    record(result, SLOPPY, "r1");
    expect(result.current.settings.charWpm).toBe(25);
    expect(result.current.settings.farnsworthWpm).toBe(12);
  });

  it("grades that recording against the speed declared, not its own", () => {
    const { result } = renderHook(() => useTake());
    act(() => result.current.reset({ charWpm: 25, farnsworthWpm: 12 }));
    record(result, SLOPPY, "r1");

    const take = result.current.runs[0]!.take;
    expect(take.target).toMatchObject({ charWpm: 25, farnsworthWpm: 12 });
    // And it is recorded as a target that was asked for rather than inferred.
    expect(take.target.explicit).toBe(true);
  });

  it("still reads an opened file at its own speed", () => {
    /* A file was made somewhere else, possibly by somebody else, and nobody
       declared anything about it. Inferring its speed is the only thing that
       can be done, and it is what has always happened. */
    const { result } = renderHook(() => useTake());
    act(() => result.current.reset({ charWpm: 25, farnsworthWpm: 12 }));
    act(() => result.current.load(clipOf(SLOPPY), { source: "a-file.wav", id: "f1" }));
    expect(result.current.runs[0]!.take.target.explicit).toBe(false);
  });
});

