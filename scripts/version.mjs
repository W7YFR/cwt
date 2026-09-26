/* What version the app is, decided by how the work arrived.
 *
 * Every change lands on main as a merge of a prefixed branch — `feat/…`,
 * `fix/…`, `chore/…` — and that prefix is already a statement about the size
 * of the change. This reads it back out and turns it into a semver bump, so
 * the version in package.json (and therefore the one in the page footer) moves
 * on its own rather than by somebody remembering to move it.
 *
 * Nothing here pushes, and no workflow runs it with anything it could push
 * with. You run `make bump` on your branch before opening the pull request;
 * the release commit rides in with the change, and CI only checks that it is
 * there (`--check`). That split is deliberate and it is a security property:
 * the pipeline needs no token, no deploy key and no write permission on any
 * job, so a pull request that runs malicious code in CI finds nothing to take.
 *
 *   make bump                            # on your branch, before the PR
 *   node scripts/version.mjs -n          # just tell me, change nothing
 *   node scripts/version.mjs --check ... # what CI asks: is the bump in here?
 *
 * The bare version lands on stdout and the reasoning on stderr, so
 * `V=$(node scripts/version.mjs -n)` is a usable thing to write.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = `${ROOT}package.json`;
const LOCK = `${ROOT}package-lock.json`;

/* What each branch prefix is worth.
 *
 * `chore` bumps the patch rather than nothing, which is the one choice here
 * worth defending: two different deploys sharing a version string makes the
 * footer a lie precisely when somebody is using it to tell you what they are
 * looking at. A dependency bump or a CSS tidy is a different build of the app,
 * so it gets a different number.
 *
 * Anything unrecognized is a patch. The alternative — refusing to bump on a
 * prefix nobody thought of — fails a release for a spelling. */
const LEVELS = /** @type {const} */ ({
  feat: "minor",
  fix: "patch",
  perf: "patch",
  refactor: "patch",
  chore: "patch",
  docs: "patch",
  test: "patch",
  build: "patch",
  ci: "patch",
  style: "patch",
  revert: "patch",
});

/** @typedef {"major" | "minor" | "patch"} Level */

/** Strongest first, so a merge carrying several kinds of commit takes the
 *  largest claim any of them makes.
 *  @type {readonly Level[]} */
const RANK = ["major", "minor", "patch"];

/** The subject of a release commit this script wrote, so it can recognize its
 *  own work and refuse to bump twice.
 *
 *  `[skip ci]` is tolerated but never written: nothing here pushes, so nothing
 *  needs to suppress a run. It stays in the pattern because a release commit
 *  carrying that marker — written by hand, or by some later automation — is
 *  still a release commit, and the one thing this pattern must never do is
 *  fail to recognize one. */
const RELEASE_SUBJECT = /^chore: release v\d+\.\d+\.\d+( \[skip ci\])?$/;

/** Whether a subject is one of this script's own release commits.
 *
 * Exported because it is the idempotency guard, and the guard is what stops a
 * version from climbing by itself: a second run on the same branch, or a merge
 * whose incoming commits already carry a release, both have to be able to
 * recognize one.
 *
 * @param {string} subject
 * @returns {boolean} */
export function isReleaseSubject(subject) {
  return RELEASE_SUBJECT.test(subject);
}

// ---- reading the commit ---------------------------------------------------- //

/** The branch name a merge commit's subject mentions, if it mentions one.
 *
 * Git writes several shapes and GitHub writes another, and they all have to
 * work because they all show up in a real history:
 *
 *   Merge branch 'feat/foo'                        git merge, local branch
 *   Merge branch 'feat/foo' into main              ...with a non-default HEAD
 *   Merge 'feat/foo'                               a hand-written subject
 *   Merge remote-tracking branch 'origin/feat/foo' git merge of a fetched ref
 *   Merge pull request #7 from w7yfr/feat/foo      GitHub's merge button
 *
 * Returned with any remote or fork owner stripped off the front, because the
 * only part that carries meaning is the prefix and what follows it.
 *
 * @param {string} subject
 * @returns {string | null} */
export function branchFromMerge(subject) {
  const quoted = subject.match(/^Merge (?:[\w-]+ )*?(?:branch|branches) '([^']+)'/i);
  const bare = subject.match(/^Merge '([^']+)'/i);
  const pr = subject.match(/^Merge pull request #\d+ from (\S+)/i);
  const raw = quoted?.[1] ?? bare?.[1] ?? pr?.[1];
  if (!raw) return null;

  /* `origin/feat/foo` and `w7yfr/feat/foo` both want their first segment
     dropped, and `feat/foo` does not — the difference is that a type is a type,
     so a leading segment that names one is kept and anything else is a remote
     or a fork owner. One segment, not "keep dropping until a type shows up":
     that looser rule turns `chore/vendor/feat/x` into a minor bump, when the
     person who named the branch said chore. */
  const parts = raw.split("/");
  // The `!` of a `feat!/…` branch is part of the claim, not part of the name.
  const head = (parts[0] ?? "").replace(/!$/, "");
  if (parts.length > 1 && !(head in LEVELS)) return parts.slice(1).join("/");
  return raw;
}

/** The conventional-commit type at the front of a string, and whether it was
 *  marked breaking with a `!`.
 *
 * Deliberately loose about the separator: a branch says `feat/foo` and a commit
 * says `feat: foo`, and both are the same claim written for a different reader.
 *
 * @param {string} text
 * @returns {{ type: string, breaking: boolean } | null} */
export function typeOf(text) {
  /* The optional `(scope)` is conventional-commits' own; it appears in commit
     subjects like `fix(dsp)!: …` and is never part of the decision. */
  const m = text.trim().match(/^([a-zA-Z]+)(\([^)]*\))?(!)?\s*[/:]/);
  if (!m) return null;
  return { type: (m[1] ?? "").toLowerCase(), breaking: Boolean(m[3]) };
}

/** The bump one branch name or commit subject asks for, given where the
 *  version currently stands.
 *
 * `major` is special while the major is 0: pre-1.0, the minor IS the breaking
 * axis by convention, and a `feat!/…` branch that shoved 0.1.0 to 1.0.0 would
 * be announcing a stable API nobody decided to promise. Going to 1.0.0 is a
 * deliberate act, so it lives behind `--release major` instead.
 *
 * @param {string} text a branch name (`feat/foo`) or subject (`feat: foo`)
 * @param {number} major the current major, for the 0.x rule above
 * @returns {Level | null} */
export function levelFor(text, major) {
  const t = typeOf(text);
  if (!t) return null;
  if (t.breaking) return major === 0 ? "minor" : "major";
  return LEVELS[/** @type {keyof typeof LEVELS} */ (t.type)] ?? "patch";
}

/** The next version after applying a bump.
 *
 * Lower fields reset, which is the whole difference between a version and three
 * counters: 0.1.7 + minor is 0.2.0, not 0.2.7.
 *
 * @param {string} version
 * @param {Level} level
 * @returns {string} */
export function bump(version, level) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`not a plain semver version: ${version}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** What a commit asks for, and why.
 *
 * The branch prefix is the primary source, per the convention this repo
 * actually follows. The fallbacks matter for the cases where it says nothing:
 * a squash merge has no branch in its subject (`feat: thing (#7)`), and a merge
 * of a branch named `wip` or `rob/tuesday` has a prefix that means nothing — in
 * which case the commits are asked instead, and the strongest claim among them
 * wins. A bump derived from `wip` would be a patch that silently swallowed a
 * feature.
 *
 * `subject` goes into that set rather than ahead of it, which is the fix for a
 * bug this had at first: a rebase merge lands several commits and no merge
 * commit, so HEAD is simply the last of them. Reading it first turned
 * `chore: rename a file`, `feat: zen mode`, `chore: tidy up` into a patch and
 * dropped the feature on the floor. HEAD's subject is one of the things that
 * landed; it is not the most important one just for being last.
 *
 * `branch` is for the callers who know the branch name without having to read
 * it back out of a subject — a pull request knows its own head ref, and so does
 * anyone standing on the branch before merging it. Given one, it wins: it is
 * the thing the author actually chose, where a subject is a reconstruction of
 * it.
 *
 * @param {{ subject: string, body?: string, branch?: string | null, merged?: readonly string[], major?: number }} commit
 * @returns {{ level: Level, reason: string }} */
export function decide(commit) {
  const { subject, body = "", branch: given = null, merged = [], major = 0 } = commit;

  /* A body-level `BREAKING CHANGE:` outranks everything the subject says —
     that is the footer's entire purpose in conventional commits, and it is
     where a breaking change gets explained rather than just flagged. */
  if (/^BREAKING[ -]CHANGE:/m.test(body)) {
    return { level: major === 0 ? "minor" : "major", reason: "BREAKING CHANGE in the commit body" };
  }

  if (given) {
    const level = levelFor(given, major);
    if (level) return { level, reason: `branch '${given}'` };
  }

  const branch = branchFromMerge(subject);
  if (branch) {
    const level = levelFor(branch, major);
    if (level) return { level, reason: `merge of '${branch}'` };
  }

  /* A `--since` range already contains HEAD, so only prepend the subject when
     it is not in there — otherwise the count in the reason is off by one and
     names the same commit twice. */
  const pool = merged.includes(subject) ? merged : [subject, ...merged];
  const claims = pool
    .map((s) => ({ s, level: levelFor(s, major) }))
    .filter((c) => c.level !== null);
  if (claims.length) {
    const strongest = /** @type {Level} */ (RANK.find((l) => claims.some((c) => c.level === l)));
    const from = truncate(claims.find((c) => c.level === strongest)?.s ?? "");
    return {
      level: strongest,
      reason:
        pool.length === 1
          ? `commit subject '${from}'`
          : `strongest of ${pool.length} commit(s) that landed: '${from}'`,
    };
  }

  return { level: "patch", reason: `nothing to go on in '${truncate(subject)}'` };
}

/** @param {string} s */
function truncate(s) {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** Whether a version already carries the bump a change is asking for.
 *
 * This is the check CI runs on a pull request, and it is the whole reason the
 * pipeline needs no write access to anything: the bump arrives in the branch,
 * made by a person, and the machine only says yes or no.
 *
 * A stronger bump than required passes. Somebody who ran `--release major` on
 * a `fix/` branch meant it, and failing them for exceeding the minimum would
 * be a rule enforcing its own arithmetic rather than the thing it is for.
 * Weaker, equal, or backwards fails.
 *
 * @param {string} base the version on the branch being merged into
 * @param {string} actual the version the change would land
 * @param {Level} required
 * @returns {{ ok: boolean, expected: string, why: string }} */
export function verifyBump(base, actual, required) {
  const expected = bump(base, required);
  if (actual === base) {
    return { ok: false, expected, why: `the version is still ${base}` };
  }
  /* Every bump at least as strong as the one asked for. RANK is strongest
     first, so "at least as strong" is a prefix of it. */
  const allowed = RANK.slice(0, RANK.indexOf(required) + 1).map((l) => bump(base, l));
  if (allowed.includes(actual)) return { ok: true, expected, why: `${base} → ${actual}` };
  /* Just what is there. Listing every version that would have been accepted
     reads like a puzzle — "not one of 1.0.0, 0.2.0" — when the caller already
     says which one was wanted. */
  return { ok: false, expected, why: `the version is ${actual}` };
}

/** The files a build reads. A change that touches none of them builds the same
 *  site, so it needs no version and no deploy. `app/test/` is absent on
 *  purpose: tests never reach `dist/`.
 *  @type {readonly RegExp[]} */
const BUILD_INPUTS = [
  /^app\/(src|public)\//,
  /^app\/index\.html$/,
  /^vite\.config\.ts$/,
  /^tsconfig\.json$/,
  /^package(-lock)?\.json$/,
];

/** Whether any of these paths is a build input.
 *  @param {readonly string[]} paths
 *  @returns {boolean} */
export function ships(paths) {
  return paths.some((p) => BUILD_INPUTS.some((re) => re.test(p)));
}

/** The paths that non-release commits touched, out of `git log --name-only
 *  --format=%x00%s`. Release commits are dropped because their package.json
 *  edit is the bump, not a change that asks for one.
 *  @param {string} log
 *  @returns {string[]} */
export function touchedPaths(log) {
  return log
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const [subject = "", ...paths] = entry.split("\n");
      return isReleaseSubject(subject) ? [] : paths.filter(Boolean);
    });
}

// ---- writing it down ------------------------------------------------------- //

/** package.json with its version field changed and nothing else touched.
 *
 * Text surgery rather than parse-and-restringify: the diff of a release should
 * be one line, and a round trip through JSON.stringify is one prettier-run away
 * from being a diff of the whole file. The first `"version"` in the file is the
 * package's own — dependency versions live inside nested objects, further down.
 *
 * @param {string} text
 * @param {string} version
 * @returns {string} */
export function withVersion(text, version) {
  const m = text.match(/^(\s*)"version":\s*"[^"]*"/m);
  if (!m) throw new Error("no version field in package.json");
  return text.replace(m[0], `${m[1] ?? ""}"version": "${version}"`);
}

/** The lockfile with both of its copies of the package version updated.
 *
 * Parsed rather than rewritten as text, because the value appears twice at two
 * different depths and a regex over a 100 kB file full of other versions is a
 * coin flip. npm writes lockfiles as `JSON.stringify(x, null, 2)` plus a
 * newline, so the round trip is byte-identical apart from the two fields — a
 * test holds that.
 *
 * Both copies, because `npm ci` compares them: leaving `packages[""]` behind
 * makes the lockfile "out of sync with package.json" and fails the install
 * step of every build after the release.
 *
 * @param {string} text
 * @param {string} version
 * @returns {string} */
export function lockWithVersion(text, version) {
  /** @type {{ version?: string, packages?: Record<string, { version?: string }> }} */
  const lock = JSON.parse(text);
  if (lock.version !== undefined) lock.version = version;
  const root = lock.packages?.[""];
  if (root?.version !== undefined) root.version = version;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

// ---- the CLI --------------------------------------------------------------- //

/** @param {readonly string[]} args */
function git(...args) {
  return execFileSync("git", [...args], { cwd: ROOT, encoding: "utf8" }).trim();
}

const USAGE = `Move the version, or check that a branch already has.

  node scripts/version.mjs [options]

The bump comes from a branch prefix — feat/ is a minor, fix/ and chore/ are
patches. Run it on your branch before the pull request (\`make bump\`); CI runs
it with --check and writes nothing.

  -n, --dry-run       print the next version; write nothing
      --commit        make the release commit (needs an otherwise clean tree)
      --tag           annotate a tag vX.Y.Z at the release commit
      --check         verify the bump is already here; make no changes
      --ships         print whether the change touches a build input
      --base <rev>    what --check compares against (the branch being merged into)
      --ref <rev>     read this commit instead of HEAD
      --branch <name> take the prefix from this branch name, not the subject
      --since <rev>   also consider every commit in <rev>..HEAD
      --release <l>   force the level: major | minor | patch
  -h, --help          this

The version goes to stdout; the reasoning goes to stderr.`;

function main() {
  const argv = process.argv.slice(2);
  /** @type {{ dry: boolean, commit: boolean, tag: boolean, check: boolean, ships: boolean, ref: string, base: string | null, branch: string | null, since: string | null, force: Level | null }} */
  const opts = { dry: false, commit: false, tag: false, check: false, ships: false, ref: "HEAD", base: null, branch: null, since: null, force: null };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n" || a === "--dry-run") opts.dry = true;
    else if (a === "--commit") opts.commit = true;
    else if (a === "--tag") opts.tag = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--ships") opts.ships = true;
    else if (a === "--base") opts.base = argv[++i] ?? null;
    else if (a === "--ref") opts.ref = argv[++i] ?? "HEAD";
    else if (a === "--branch") opts.branch = argv[++i] ?? null;
    else if (a === "--since") opts.since = argv[++i] ?? null;
    else if (a === "--release") {
      const level = argv[++i] ?? "";
      if (!RANK.includes(/** @type {Level} */ (level))) die(`--release wants one of ${RANK.join(", ")}`);
      opts.force = /** @type {Level} */ (level);
    } else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return;
    } else die(`unknown option: ${a}\n\n${USAGE}`);
  }

  /* A tag names the commit that IS version X.Y.Z. Tagging without committing
     would point v0.2.0 at the merge commit, whose package.json still says
     0.1.0 — a tag that disagrees with what it tags. */
  if (opts.tag && !opts.commit) die("--tag needs --commit: a tag marks the release commit");

  /* In --check the range is the pull request: base..HEAD is exactly what would
     land, so --base doubles as --since and nobody has to pass both. */
  const since = opts.since ?? (opts.check ? opts.base : null);
  const shipping = shipsIn(opts.ref, since);

  if (opts.ships) {
    process.stdout.write(`${shipping}\n`);
    const file = process.env["GITHUB_OUTPUT"];
    if (file) writeFileSync(file, `ships=${shipping}\n`, { flag: "a" });
    return;
  }

  const pkgText = readFileSync(PKG, "utf8");
  /** @type {{ version: string }} */
  const pkg = JSON.parse(pkgText);
  const current = pkg.version;
  const major = Number(current.split(".")[0]);

  const subject = git("log", "-1", "--format=%s", opts.ref);
  const body = git("log", "-1", "--format=%b", opts.ref);

  const landed = landedCommits(opts.ref, since);

  const merged = landed.filter((c) => !isReleaseSubject(c));

  const decision = opts.force
    ? { level: opts.force, reason: "--release on the command line" }
    : decide({ subject, body, branch: opts.branch, merged, major });
  const next = bump(current, decision.level);

  /* Its own release commit is not a change to release. Two shapes of the same
     mistake: HEAD IS the release commit (you ran `make bump` twice on the
     branch), or the release commit came in with the change (you ran it on the
     branch, as intended, and are now standing on main after the merge). The
     second is the one that bites, because a merge subject still names a
     `feat/` branch and reads like a change nobody has versioned yet. */
  const already = isReleaseSubject(subject)
    ? `${opts.ref} is already a release commit (${subject})`
    : landed.some(isReleaseSubject)
      ? `this change already carries ${landed.find(isReleaseSubject)}`
      : null;

  if (!shipping && !opts.force) {
    process.stderr.write("no build input changed; nothing to release\n");
    process.stdout.write(`${current}\n`);
    report({ version: current, level: "none", previous: current });
    return;
  }

  if (already && !opts.force && !opts.check) {
    /* The second line is the way out of a dead end that is otherwise
       genuinely confusing: another branch merged first and took the version
       this one had reserved, so after a rebase CI asks for a bump and this
       says there is nothing to bump. Both are telling the truth — the branch
       has a release commit, and it is no longer ahead of main. */
    process.stderr.write(
      `${already}; nothing to bump\n` +
        `if ${opts.branch ? "the base branch" : "main"} has moved on since, the bump needs redoing:\n` +
        `  node scripts/version.mjs --commit --release ${decision.level}\n`,
    );
    process.stdout.write(`${current}\n`);
    /* Reported even though nothing moved, because a caller still has a version
       to name and an empty output reads as a broken run rather than a repeat
       of a good one. */
    report({ version: current, level: "none", previous: current });
    return;
  }

  if (opts.check) {
    check(opts.base, current, decision);
    return;
  }

  process.stderr.write(`${current} → ${next}  (${decision.level}: ${decision.reason})\n`);
  process.stdout.write(`${next}\n`);

  report({ version: next, level: decision.level, previous: current });

  if (opts.dry) return;

  /* Checked before anything is written, not after. The first cut of this asked
     about the tree between writing the files and making the commit, so a run
     that refused to commit still left a bumped package.json behind — the one
     outcome nobody asked for. */
  if (opts.commit) assertNothingElsePending();

  writeFileSync(PKG, withVersion(pkgText, next));
  writeFileSync(LOCK, lockWithVersion(readFileSync(LOCK, "utf8"), next));
  process.stderr.write("wrote package.json, package-lock.json\n");

  if (opts.commit) {
    const subjectLine = `chore: release v${next}`;
    git("add", "--", PKG, LOCK);
    git("commit", "-m", subjectLine);
    process.stderr.write(`committed ${subjectLine}\n`);
  }

  if (opts.tag) {
    /* A re-run of a workflow reaches here with the tag already made — the same
       version, the same commit, nothing wrong. Failing on that would turn a
       harmless "deploy it again" button into a red build, so it is only an
       error when the tag exists and means something else. */
    const at = tagPoint(`v${next}`);
    const head = git("rev-parse", "HEAD");
    if (at === head) {
      process.stderr.write(`v${next} is already tagged here\n`);
    } else if (at) {
      die(`v${next} already exists and points at ${at.slice(0, 9)}, not this commit`);
    } else {
      git("tag", "-a", `v${next}`, "-m", `v${next}`);
      process.stderr.write(`tagged v${next} (not pushed — \`git push --follow-tags\` when you mean it)\n`);
    }
  }
}

/** CI's half of the bargain: the bump is made by a person on a branch, and
 *  this says whether it is actually there.
 *
 * Everything it needs is readable — a version out of the base commit, a
 * version off the disk — which is what lets the whole pipeline run with no
 * write permission anywhere in it.
 *
 * @param {string | null} baseRev
 * @param {string} actual
 * @param {{ level: Level, reason: string }} decision
 * @returns {void} */
function check(baseRev, actual, decision) {
  if (!baseRev) die("--check needs --base <rev>: the branch this would be merged into");
  const base = versionAt(baseRev);
  const verdict = verifyBump(base, actual, decision.level);

  if (verdict.ok) {
    process.stderr.write(`${verdict.why} — ${decision.level}, ${decision.reason}\n`);
    process.stdout.write(`${actual}\n`);
    report({ version: actual, level: decision.level, previous: base });
    return;
  }

  /* The message is the whole user interface of a failing check, so it says
     what was wanted, what is there, and the one command that fixes it. A check
     that only says "version not bumped" sends people to read this file. */
  die(
    [
      `This change needs a ${decision.level} bump — ${decision.reason}.`,
      `${short(baseRev)} is at ${base}, so merging should land ${verdict.expected}, but ${verdict.why}.`,
      "",
      "Run `make bump` on the branch, then push the release commit it makes.",
    ].join("\n"),
  );
}

/** The package version as of some commit.
 *  @param {string} rev @returns {string} */
function versionAt(rev) {
  let text;
  try {
    text = git("show", `${rev}:package.json`);
  } catch {
    /* Nearly always a shallow clone: CI checks out depth 1 by default and the
       base commit is simply not in it. Worth saying, because the error git
       gives for a missing object reads like the file is missing. */
    die(`cannot read package.json at ${short(rev)} — is the clone deep enough? (fetch-depth: 0)`);
  }
  /** @type {{ version: string }} */
  const pkg = JSON.parse(text);
  return pkg.version;
}

/** @param {string} rev */
function short(rev) {
  return /^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 9) : rev;
}

/** Refuse to release on top of unrelated work.
 *
 * A release commit is worth having because it contains exactly the version
 * move and nothing else; a tree with other changes in it is a sign the timing
 * is wrong rather than a thing to work around. package.json and the lockfile
 * are exempt because they are what this script is here to change.
 *
 * @returns {void} */
function assertNothingElsePending() {
  const dirty = git("status", "--porcelain")
    .split("\n")
    .filter(Boolean)
    .filter((l) => !/package(-lock)?\.json$/.test(l));
  if (dirty.length) die(`the tree has other changes; commit or stash them first:\n${dirty.join("\n")}`);
}

/** The commit subjects that arrived with this change, for when the subject
 *  itself says nothing useful.
 *
 * Two sources, and which one is right depends on how the branch landed:
 *
 *   --since <rev>   everything in <rev>..HEAD. A workflow knows the previous
 *                   tip of the branch it is building, so this covers a push of
 *                   several commits and a rebase merge — neither of which
 *                   leaves a merge commit to read parents off at all.
 *   a merge commit  its second parent's side, HEAD^1..HEAD^2.
 *
 * Returned unfiltered, release commits included. They are dropped before the
 * claims are counted — `chore: release v0.2.0` is a patch claim about nothing
 * — but their presence is itself the answer to a different question, which is
 * whether this change has already been versioned.
 *
 * @param {string} ref
 * @param {string | null} since
 * @returns {string[]} */
function landedCommits(ref, since) {
  /** @type {string[]} */
  let subjects = [];
  if (since && revExists(since)) {
    subjects = git("log", "--no-merges", "--format=%s", `${since}..${ref}`).split("\n");
  } else {
    if (since) process.stderr.write(`--since ${since} is not a commit here; ignoring it\n`);
    /* Only asked for on a merge, because anywhere else the range does not
       exist and git would rather say so than shrug. */
    if (isMerge(ref)) subjects = git("log", "--format=%s", `${ref}^1..${ref}^2`).split("\n");
  }
  return subjects.filter(Boolean);
}

/** Whether the change up to `ref` touches a build input. The range follows
 *  landedCommits, plus `main..ref` for a branch before its merge. With no
 *  range to read, the answer is yes, so a release is never skipped by
 *  accident.
 *
 *  @param {string} ref
 *  @param {string | null} since
 *  @returns {boolean} */
function shipsIn(ref, since) {
  const range =
    since && revExists(since) ? `${since}..${ref}`
    : isMerge(ref) ? `${ref}^1..${ref}`
    : revExists("main") ? `main..${ref}`
    : null;
  if (!range) return true;
  return ships(touchedPaths(git("log", "--no-merges", "--name-only", "--format=%x00%s", range)));
}

/** @param {string} rev @returns {boolean} */
function revExists(rev) {
  try {
    git("rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** The commit a tag points at, or null if there is no such tag.
 *
 * Asked as two questions rather than one, because `rev-list` on a tag that is
 * not there writes `fatal: ambiguous argument` to stderr on its way to
 * throwing — and "this tag does not exist yet" is the normal case on every
 * release. A workflow log full of fatal errors that turned out to be fine is a
 * log nobody reads the next time.
 *
 * @param {string} tag @returns {string | null} */
function tagPoint(tag) {
  if (git("tag", "--list", tag) === "") return null;
  return git("rev-list", "-1", `refs/tags/${tag}`);
}

/** @param {string} ref */
function isMerge(ref) {
  return git("rev-list", "--parents", "-1", ref).split(" ").length > 2;
}

/** Hand the answer to the workflow that asked, so it can name the version in a
 *  summary or a deploy message without parsing prose off stderr. Absent
 *  outside Actions, where it does nothing at all.
 *
 *  @param {{ version: string, level: Level | "none", previous: string }} out
 *  @returns {void} */
function report(out) {
  const file = process.env["GITHUB_OUTPUT"];
  if (!file) return;
  writeFileSync(file, `version=${out.version}\nlevel=${out.level}\nprevious=${out.previous}\n`, { flag: "a" });
}

/** @param {string} message @returns {never} */
function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/* Imported by the tests, run by hand and by CI — so the CLI only happens when
   this file IS the program. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
