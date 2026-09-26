import { describe, expect, it } from "vitest";
import { DRILLS, groupDrills } from "@/drills";
import { CHAR_TO_MORSE, tokenize } from "@/morse";
import { oneLine } from "@/ui/NewSession";

describe("the drill catalog", () => {
  it("has unique ids", () => {
    const ids = DRILLS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stores each text the way the dialog hands it over", () => {
    for (const d of DRILLS) expect(d.text).toBe(oneLine(d.text));
  });

  it("holds only symbols that have a keying", () => {
    for (const d of DRILLS) {
      const missing = tokenize(d.text).filter((t) => t !== " " && !(t in CHAR_TO_MORSE));
      expect(missing, d.id).toEqual([]);
    }
  });

  it("groups by path in catalog order", () => {
    const groups = groupDrills(DRILLS);
    expect(groups.map((g) => g.name)).toEqual(["Daily Sending"]);
    expect(groups[0]!.sections.map((s) => s.name)).toEqual(["Warm Up", "Exercise", "Drill"]);
    expect(groups.flatMap((g) => g.sections.flatMap((s) => s.drills))).toEqual(DRILLS);
  });
});
