import { describe, expect, it } from "vitest";
import { DRILLS, SLOTS, fillDrill, fillDrills, groupDrills, slotsOf } from "@/drills";
import { EMPTY_USER, type UserInfo } from "@/io/storage";
import { CHAR_TO_MORSE, tokenize } from "@/morse";
import { oneLine } from "@/ui/NewSession";

const USER: UserInfo = {
  name: "ROB",
  callsign: "W7YFR",
  age: "42",
  yearLicensed: "2024",
  qthCity: "PORTLAND",
  qthRegionShort: "OR",
  qthRegionLong: "OREGON",
  antenna: "EFHW",
  rigManufacturer: "YAESU",
  rigModel: "FT-710",
  rigPower: "100",
};

describe("the drill catalog", () => {
  it("has unique ids", () => {
    const ids = DRILLS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only slots that read a user detail", () => {
    for (const d of DRILLS) {
      for (const slot of slotsOf(d.text)) expect(Object.keys(SLOTS), d.id).toContain(slot);
    }
  });

  it("fills every slot once the details are set", () => {
    for (const d of fillDrills(DRILLS, USER)) {
      expect(d.missing ?? [], d.id).toEqual([]);
      expect(d.text, d.id).not.toMatch(/[{}[\]]/);
    }
  });

  it("stores each text the way the dialog hands it over", () => {
    for (const d of fillDrills(DRILLS, USER)) expect(d.text).toBe(oneLine(d.text));
  });

  it("holds only symbols that have a keying", () => {
    for (const d of fillDrills(DRILLS, USER)) {
      const missing = tokenize(d.text).filter((t) => t !== " " && !(t in CHAR_TO_MORSE));
      expect(missing, d.id).toEqual([]);
    }
  });

  it("groups by path in catalog order", () => {
    const groups = groupDrills(DRILLS);
    expect(groups.map((g) => g.name)).toEqual(["Daily Sending", "QSO"]);
    expect(groups[0]!.sections.map((s) => s.name)).toEqual(["Warm Up", "Exercise", "Drill"]);
    expect(groups[1]!.sections.map((s) => s.name)).toEqual(["CQ", "Name & QTH", "Exchange"]);
    expect(groups.flatMap((g) => g.sections.flatMap((s) => s.drills))).toEqual(DRILLS);
  });
});

describe("filling a drill", () => {
  const drill = { id: "t", path: ["G", "S"] as const, text: "NAME IS {name} {name} <BT> QTH HR {region_short}" };

  it("puts the user's details in its slots", () => {
    expect(fillDrill(drill, USER)).toMatchObject({
      text: "NAME IS ROB ROB <BT> QTH HR OR",
      missing: [],
    });
  });

  it("names the slots that have no value, once each", () => {
    const got = fillDrill(drill, { ...EMPTY_USER, name: "ROB" });
    expect(got.text).toBe("NAME IS ROB ROB <BT> QTH HR [REGION_SHORT]");
    expect(got.missing).toEqual(["region_short"]);
  });

  it("treats a value of only spaces as no value", () => {
    expect(fillDrill(drill, { ...USER, name: "  " }).missing).toEqual(["name"]);
  });

  it("collapses the spaces a multi-word value leaves", () => {
    expect(fillDrill(drill, { ...USER, qthRegionShort: " NEW  SOUTH WALES " }).text).toBe(
      "NAME IS ROB ROB <BT> QTH HR NEW SOUTH WALES",
    );
  });

  it("hands back a drill with no slots unchanged", () => {
    const plain = DRILLS[0]!;
    expect(fillDrill(plain, EMPTY_USER)).toBe(plain);
  });
});
