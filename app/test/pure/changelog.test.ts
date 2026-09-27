/* The changelog entry a branch writes, and the version the release commit
 * moves it under. The entry must merge with its version, so a stamp that
 * loses text or a check that passes a missing entry are the failures here. */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { added, entry, sections, stamp, unreleased, verifyEntry } from "../../../scripts/changelog.mjs";
import { title } from "../../../scripts/pr.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const PENDING = `# Changelog

Intro.

## Unreleased

### Fixed

- A thing.

## v1.0.0 — 2026-09-19

### Added

- Everything.
`;

describe("reading the file", () => {
  it("finds each section, its version, and its body", () => {
    expect(sections(PENDING).map((s) => [s.heading, s.version])).toEqual([
      ["Unreleased", null],
      ["v1.0.0 — 2026-09-19", "1.0.0"],
    ]);
    expect(unreleased(PENDING)).toBe("### Fixed\n\n- A thing.");
    expect(entry(PENDING, "1.0.0")).toBe("### Added\n\n- Everything.");
    expect(entry(PENDING, "1.0.1")).toBeNull();
  });

  it("does not read a longer version as a shorter one", () => {
    expect(entry("## v1.0.10 — 2026-01-01\n\n- x\n", "1.0.1")).toBeNull();
  });
});

describe("stamping a release", () => {
  const out = stamp(PENDING, "1.0.1", "2026-09-20");

  it("moves the pending entry under the version and leaves Unreleased empty", () => {
    expect(unreleased(out)).toBe("");
    expect(entry(out, "1.0.1")).toBe("### Fixed\n\n- A thing.");
    expect(out).toContain("## Unreleased\n\n## v1.0.1 — 2026-09-20\n\n### Fixed");
  });

  it("keeps everything else as it was", () => {
    expect(out.startsWith("# Changelog\n\nIntro.\n\n## Unreleased\n")).toBe(true);
    expect(out.endsWith("## v1.0.0 — 2026-09-19\n\n### Added\n\n- Everything.\n")).toBe(true);
  });

  it("refuses with no entry, and refuses a version already there", () => {
    expect(() => stamp(out, "1.0.2", "2026-09-20")).toThrow(/nothing under '## Unreleased'/);
    expect(() => stamp(PENDING, "1.0.0", "2026-09-20")).toThrow(/already has a v1.0.0/);
    expect(() => stamp("# Changelog\n", "1.0.0", "2026-09-20")).toThrow(/no '## Unreleased'/);
  });

  it("stamps a file whose Unreleased section is last", () => {
    const got = stamp("# Changelog\n\n## Unreleased\n\n- First.\n", "1.0.0", "2026-09-19");
    expect(got).toBe("# Changelog\n\n## Unreleased\n\n## v1.0.0 — 2026-09-19\n\n- First.\n");
  });
});

describe("what CI checks", () => {
  it("passes a stamped release and fails the ways a branch goes wrong", () => {
    expect(verifyEntry(stamp(PENDING, "1.0.1", "2026-09-20"), "1.0.1").ok).toBe(true);
    // Bumped by hand, entry never moved.
    expect(verifyEntry(PENDING, "1.0.1").why).toMatch(/no v1.0.1 section/);
    // Stamped, then a second entry written after it.
    const again = stamp(PENDING, "1.0.1", "2026-09-20").replace("## Unreleased\n", "## Unreleased\n\n- Late.\n");
    expect(verifyEntry(again, "1.0.1").why).toMatch(/still has text/);
    expect(verifyEntry("## Unreleased\n\n## v1.0.1 — 2026-09-20\n", "1.0.1").why).toMatch(/is empty/);
  });

  it("holds for the repository: the version the app shows has an entry", () => {
    const text = readFileSync(`${ROOT}CHANGELOG.md`, "utf8");
    const version = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")).version;
    expect(entry(text, version)).toBeTruthy();
  });
});

describe("the lines one branch wrote", () => {
  it("drops the pending lines other branches merged, and keeps their groups", () => {
    const base = "### Development\n\n- CI thing.";
    const head = "### Added\n\n- New control.\n\n### Development\n\n- CI thing.\n- Make thing.";
    expect(added(base, head)).toBe("### Added\n\n- New control.\n\n### Development\n\n- Make thing.");
  });

  it("drops a group this branch added nothing to", () => {
    expect(added("### Development\n\n- CI thing.", "### Development\n\n- CI thing.\n\n### Fixed\n\n- Bug.")).toBe(
      "### Fixed\n\n- Bug.",
    );
    expect(added("- Same.", "- Same.")).toBe("");
  });

  it("keeps everything when main has nothing pending", () => {
    expect(added("", "Intro.\n\n### Added\n\n- A.")).toBe("Intro.\n\n### Added\n\n- A.");
  });
});

describe("the pull request title", () => {
  it("names the type and the version", () => {
    expect(title("feat/custom-drills", "1.3.0")).toBe("[FEAT] v1.3.0");
    expect(title("fix/mobile", "1.0.2")).toBe("[FIX] v1.0.2");
  });

  it("names the branch when nothing is released, unless told otherwise", () => {
    expect(title("chore/release-target", null)).toBe("[CHORE] Release Target");
    expect(title("chore/ships-unreadable-range", null, "Deploy Gap")).toBe("[CHORE] Deploy Gap");
  });
});
