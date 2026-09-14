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
