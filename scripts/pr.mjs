/* Open the pull request for the branch you are standing on.
 *
 * Bumps the version (`make bump`, which does nothing when the bump is already
 * there), pushes the branch, and opens the pull request, or updates the one
 * already open. The title is `[TYPE] vX.Y.Z` and the body is the CHANGELOG.md
 * entry for that version. A branch that touches no build input releases no
 * version, so its title comes from the branch name.
 *
 *   make pr
 *   make pr TITLE="Deploy Gap"   # title for a branch that releases nothing
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHANGELOG, entry, unreleased } from "./changelog.mjs";
import { isReleaseSubject } from "./version.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = fileURLToPath(new URL("./version.mjs", import.meta.url));

/** `[FEAT] v1.3.0`, or `[CHORE] Deploy Gap` for a branch with no version.
 *
 * @param {string} branch
 * @param {string | null} version
 * @param {string | null} name overrides the name taken from the branch
 * @returns {string} */
export function title(branch, version, name = null) {
  const slash = branch.indexOf("/");
  const type = slash < 0 ? "CHORE" : branch.slice(0, slash).replace(/!$/, "").toUpperCase();
  if (version) return `[${type}] v${version}`;
  const words = (slash < 0 ? branch : branch.slice(slash + 1)).split(/[-_/]+/).filter(Boolean);
  return `[${type}] ${name ?? words.map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ")}`;
}

/** @param {string} cmd @param {readonly string[]} args @param {string} [input] */
function run(cmd, args, input) {
  return execFileSync(cmd, [...args], {
    cwd: ROOT,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
  }).trim();
}

/** @param {string} message @returns {never} */
function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  /** @type {string | null} */
  let name = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--title") name = argv[++i] || null;
    else die(`unknown option: ${argv[i]}\n\nusage: node scripts/pr.mjs [--title <text>]`);
  }

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "main" || branch === "HEAD") die("make pr runs on a branch, not on main");

  const ships = run(process.execPath, [VERSION, "--ships"]) === "true";

  /** @type {string | null} */
  let version = null;
  let body;
  if (ships) {
    const bumped = run("git", ["log", "--format=%s", "main..HEAD"]).split("\n").some(isReleaseSubject);
    if (!bumped) run(process.execPath, [VERSION, "--commit", "--branch", branch]);
    /** @type {{ version: string }} */
    const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8"));
    version = pkg.version;
    const logged = entry(readFileSync(CHANGELOG, "utf8"), version);
    if (!logged) die(`CHANGELOG.md has no v${version} entry; write it under '## Unreleased' and run make pr again`);
    body = `${logged}\n`;
  } else {
    if (unreleased(readFileSync(CHANGELOG, "utf8"))) {
      process.stderr.write("warning: this branch releases nothing, so its '## Unreleased' entry waits for the next release\n");
    }
    body = "This change touches no build input, so it releases no version and deploys nothing.\n";
  }

  const dirty = run("git", ["status", "--porcelain"]);
  if (dirty) die(`the tree has uncommitted changes; commit or stash them first:\n${dirty}`);

  run("git", ["push", "--set-upstream", "origin", branch]);

  const heading = title(branch, version, name);
  let open = "";
  try {
    open = run("gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"]);
  } catch {
    // No pull request for this branch yet.
  }
  if (open === "OPEN") {
    run("gh", ["pr", "edit", branch, "--title", heading, "--body-file", "-"], body);
    process.stdout.write(`${run("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"])}\n`);
  } else {
    process.stdout.write(`${run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", heading, "--body-file", "-"], body)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
