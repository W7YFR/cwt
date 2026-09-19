/* What the release script decides, and what it writes.
 *
 * The version in the footer is the only thing a user can quote back at you, so
 * the interesting failures here are the quiet ones: a branch prefix that reads
 * as nothing and silently becomes a patch when a feature landed, a lockfile
 * left a version behind so every build after the release fails at `npm ci`, a
 * second run that bumps again because it did not recognize its own commit.
 * Each of those has a case below.
 *
 * The script is plain JS with JSDoc types (see tsconfig — allowJs + checkJs) so
 * that running it needs no build step; importing it here is the same module
 * `node scripts/version.mjs` runs.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  branchFromMerge,
  bump,
  decide,
  isReleaseSubject,
  verifyBump,
  levelFor,
  lockWithVersion,
  typeOf,
  withVersion,
} from "../../../scripts/version.mjs";
import { APP_VERSION } from "@/build-info";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("reading the branch off a merge commit", () => {
  it("handles every shape a merge subject actually comes in", () => {
    // git, merging a local branch — what this repo's history is full of.
    expect(branchFromMerge("Merge branch 'feat/missing-settings'")).toBe("feat/missing-settings");
    // ...with a non-default checked-out branch, which git spells out.
    expect(branchFromMerge("Merge branch 'fix/hmr' into main")).toBe("fix/hmr");
    // A subject somebody shortened by hand. Also in this repo's history.
    expect(branchFromMerge("Merge 'feat/security'")).toBe("feat/security");
    // git, merging something fetched.
    expect(branchFromMerge("Merge remote-tracking branch 'origin/chore/deploy'")).toBe("chore/deploy");
    // GitHub's merge button.
    expect(branchFromMerge("Merge pull request #7 from w7yfr/feat/deploy")).toBe("feat/deploy");
  });

  it("drops a remote or fork owner, but only one segment of it", () => {
    expect(branchFromMerge("Merge branch 'origin/feat/x'")).toBe("feat/x");

    /* The looser rule — keep dropping segments until a known type turns up —
       reads `chore/vendor/feat/x` as a feature. The person who named the branch
       said chore, and a leading segment that names a type is a type. */
    expect(branchFromMerge("Merge branch 'chore/vendor/feat/x'")).toBe("chore/vendor/feat/x");
    expect(levelFor("chore/vendor/feat/x", 0)).toBe("patch");
  });

  it("says nothing about commits that are not merges", () => {
    expect(branchFromMerge("feat: button emphasis")).toBeNull();
    expect(branchFromMerge("Merged some stuff")).toBeNull();
  });
});

describe("what a prefix is worth", () => {
  it("maps the prefixes this repo uses", () => {
    expect(levelFor("feat/x", 0)).toBe("minor");
    expect(levelFor("fix/x", 0)).toBe("patch");
    expect(levelFor("chore/x", 0)).toBe("patch");
  });

  it("reads a branch and a commit subject the same way", () => {
    // `feat/foo` and `feat: foo` are one claim written for two readers.
    expect(levelFor("feat: add a thing", 0)).toBe("minor");
    expect(typeOf("fix(dsp)!: threshold")).toEqual({ type: "fix", breaking: true });
    expect(typeOf("feat/x")).toEqual({ type: "feat", breaking: false });
    // A bare word is not a claim — no separator, no type.
    expect(typeOf("wip")).toBeNull();
  });

  it("bumps the patch for a prefix nobody thought of", () => {
    /* Not zero, and not an error: two deploys sharing a version string makes
       the footer a lie exactly when somebody is reading it to tell you what
       they are looking at, and failing a release over a spelling is worse. */
    expect(levelFor("hotfix/x", 0)).toBe("patch");
    expect(levelFor("spike/x", 0)).toBe("patch");
  });

  it("keeps a breaking change off 1.0.0 while the major is 0", () => {
    // Pre-1.0 the minor IS the breaking axis. Announcing a stable API is a
    // decision, so it stays behind `--release major`.
    expect(levelFor("feat!/rewrite", 0)).toBe("minor");
    expect(levelFor("feat!: rewrite", 0)).toBe("minor");
    // Past 1.0 it means what it says.
    expect(levelFor("feat!: rewrite", 1)).toBe("major");
  });
});

describe("the decision, end to end", () => {
  it("prefers the branch prefix", () => {
    const d = decide({ subject: "Merge branch 'feat/deploy'", major: 0 });
    expect(d.level).toBe("minor");
    expect(d.reason).toContain("feat/deploy");
  });

  it("reads a squash merge's own subject", () => {
    // GitHub's squash button writes `feat: thing (#7)` and no branch at all.
    expect(decide({ subject: "feat: thing (#7)", major: 0 }).level).toBe("minor");
  });

  it("falls back to the merged commits when the branch name means nothing", () => {
    /* The failure this prevents: a branch called `wip` carrying a feature gets
       a patch bump, and a minor release never happens. */
    const d = decide({
      subject: "Merge branch 'wip'",
      merged: ["chore: tidy", "feat: new screen", "fix: typo"],
      major: 0,
    });
    expect(d.level).toBe("minor");
    expect(d.reason).toContain("feat: new screen");
  });

  it("does not let the last commit outrank the ones beside it", () => {
    /* A rebase merge lands several commits and no merge commit, so HEAD is
       just the last of them. This read it first once, which turned a push
       carrying a feature into a patch and dropped the feature on the floor. */
    const d = decide({
      subject: "chore: tidy up",
      merged: ["chore: tidy up", "feat: zen mode", "chore: rename a file"],
      major: 0,
    });
    expect(d.level).toBe("minor");
    expect(d.reason).toContain("feat: zen mode");
    expect(d.reason).toContain("3 commit(s)");
  });

  it("takes the strongest claim among the merged commits", () => {
    const d = decide({ subject: "Merge branch 'rob/tuesday'", merged: ["chore: a", "fix: b"], major: 0 });
    expect(d.level).toBe("patch");
    expect(decide({ subject: "Merge branch 'wip'", merged: ["fix: a", "feat: b"], major: 1 }).level).toBe("minor");
  });

  it("lets a BREAKING CHANGE footer outrank the subject", () => {
    const d = decide({
      subject: "Merge branch 'fix/tone'",
      body: "BREAKING CHANGE: saved profiles from before today no longer load.\n",
      major: 1,
    });
    expect(d.level).toBe("major");
  });

  it("falls back to a patch rather than throwing", () => {
    const d = decide({ subject: "Merge branch 'wip'", merged: ["some work"], major: 0 });
    expect(d.level).toBe("patch");
  });
});

describe("the signals CI hands it", () => {
  it("prefers a branch name it was told over one it inferred", () => {
    /* A pull request knows its own head ref, and so does anyone standing on a
       branch before merging. That is the name the author chose; a subject is a
       reconstruction of it. */
    const d = decide({ subject: "Merge branch 'chore/tidy'", branch: "feat/deploy", major: 0 });
    expect(d.level).toBe("minor");
    expect(d.reason).toBe("branch 'feat/deploy'");
  });

  it("does not let a told branch name hide a breaking change", () => {
    const d = decide({
      subject: "feat: x",
      branch: "chore/tidy",
      body: "BREAKING CHANGE: profiles moved.\n",
      major: 1,
    });
    expect(d.level).toBe("major");
  });

  it("recognizes its own release commits, with or without the CI marker", () => {
    /* Both halves of the loop guard. Without the `[skip ci]` form, the commit
       a workflow pushes stops looking like a release commit to the next run,
       and the version climbs on every run rather than on every merge. */
    expect(isReleaseSubject("chore: release v0.2.0")).toBe(true);
    expect(isReleaseSubject("chore: release v0.2.0 [skip ci]")).toBe(true);
    expect(isReleaseSubject("chore: release v10.4.11 [skip ci]")).toBe(true);
    // Near misses that are somebody's real work, not a release.
    expect(isReleaseSubject("chore: release the hounds")).toBe(false);
    expect(isReleaseSubject("chore: release v0.2")).toBe(false);
    expect(isReleaseSubject("Merge branch 'chore/release-notes'")).toBe(false);
  });
});

describe("the arithmetic", () => {
  it("resets the fields below the one it bumps", () => {
    // The difference between a version and three counters.
    expect(bump("0.1.7", "minor")).toBe("0.2.0");
    expect(bump("0.1.7", "patch")).toBe("0.1.8");
    expect(bump("1.4.2", "major")).toBe("2.0.0");
  });

  it("refuses a version it cannot reason about", () => {
    expect(() => bump("0.1.0-rc.1", "patch")).toThrow(/semver/);
    expect(() => bump("v0.1.0", "patch")).toThrow(/semver/);
  });
});

describe("checking a branch already carries its bump", () => {
  /* CI's half of the bargain. A person runs `make bump` on the branch, and
     this is the only thing the pipeline has to do about versions — which is
     what lets it run with no write permission anywhere in it. */

  it("passes when the bump is exactly the one the prefix asks for", () => {
    const v = verifyBump("0.1.0", "0.2.0", "minor");
    expect(v.ok).toBe(true);
    expect(v.why).toBe("0.1.0 → 0.2.0");
  });

  it("fails when nobody bumped anything", () => {
    const v = verifyBump("0.1.0", "0.1.0", "patch");
    expect(v.ok).toBe(false);
    expect(v.expected).toBe("0.1.1");
    expect(v.why).toContain("still 0.1.0");
  });

  it("fails a bump weaker than the branch promised", () => {
    // A feature released as a patch is the failure this whole check exists for.
    expect(verifyBump("0.1.0", "0.1.1", "minor").ok).toBe(false);
    expect(verifyBump("1.0.0", "1.1.0", "major").ok).toBe(false);
  });

  it("allows a stronger bump than required", () => {
    /* Somebody who ran `--release major` on a fix branch meant it. Failing
       them for exceeding the minimum would be a rule enforcing its own
       arithmetic rather than the thing it is for. */
    expect(verifyBump("0.1.0", "0.2.0", "patch").ok).toBe(true);
    expect(verifyBump("1.2.3", "2.0.0", "minor").ok).toBe(true);
  });

  it("fails a version that moved sideways or backwards", () => {
    // A rebase gone wrong, or a hand-edited package.json.
    expect(verifyBump("0.2.0", "0.1.9", "patch").ok).toBe(false);
    expect(verifyBump("0.2.0", "0.2.5", "patch").ok).toBe(false);
    expect(verifyBump("0.2.0", "0.3.1", "minor").ok).toBe(false);
  });

  it("names what it wanted, for the message CI prints", () => {
    /* The failing message is the whole user interface of this check: it has to
       say what was wanted and what is there, or people come read this file.
       What it must NOT do is list every version that would have passed —
       "not one of 1.0.0, 0.2.0" reads as a puzzle. */
    const v = verifyBump("0.4.2", "0.4.2", "minor");
    expect(v.expected).toBe("0.5.0");
    expect(v.why).toBe("the version is still 0.4.2");

    const weak = verifyBump("0.4.2", "0.4.3", "minor");
    expect(weak.expected).toBe("0.5.0");
    expect(weak.why).toBe("the version is 0.4.3");
  });
});

describe("writing it down", () => {
  const pkgText = readFileSync(`${ROOT}package.json`, "utf8");

  it("changes one line of package.json and nothing else", () => {
    const out = withVersion(pkgText, "9.9.9");
    expect(JSON.parse(out).version).toBe("9.9.9");

    /* The release diff should be readable at a glance. A parse-and-restringify
       would pass the assertion above and rewrite the whole file. */
    const changed = out
      .split("\n")
      .map((line, i) => [line, pkgText.split("\n")[i]] as const)
      .filter(([a, b]) => a !== b);
    expect(changed).toHaveLength(1);
    expect(changed[0]![0]).toContain('"version": "9.9.9"');
  });

  it("does not mistake a dependency's version for the package's", () => {
    const out = withVersion(pkgText, "9.9.9");
    // The first `"version"` in the file is the package's own; the deps below
    // are untouched.
    expect(JSON.parse(out).devDependencies).toEqual(JSON.parse(pkgText).devDependencies);
    expect(JSON.parse(out).dependencies).toEqual(JSON.parse(pkgText).dependencies);
  });

  it("updates both of the lockfile's copies of the version", () => {
    /* `npm ci` compares them. Leaving `packages[""]` behind is the kind of bug
       that passes review and then fails the install step of every build after
       the release. */
    const lockText = readFileSync(`${ROOT}package-lock.json`, "utf8");
    const out = lockWithVersion(lockText, "9.9.9");
    const lock = JSON.parse(out);
    expect(lock.version).toBe("9.9.9");
    expect(lock.packages[""].version).toBe("9.9.9");
  });

  it("rewrites the lockfile byte for byte apart from those two fields", () => {
    /* The lockfile is parsed rather than patched as text, which is only safe
       because npm writes it as `JSON.stringify(x, null, 2)` plus a newline. If
       that ever stops being true this test fails instead of a release quietly
       reformatting 100 kB. */
    const lockText = readFileSync(`${ROOT}package-lock.json`, "utf8");
    const current = JSON.parse(lockText).version;
    expect(lockWithVersion(lockText, current)).toBe(lockText);
  });
});

describe("the version the app shows", () => {
  it("is the one in package.json", () => {
    /* The join between the release script and the page. Asserted here as well
       as through the footer, because if this breaks the footer test can only
       say the text looks odd, and this one says why. */
    expect(APP_VERSION).toBe(JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")).version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
