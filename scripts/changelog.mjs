/* CHANGELOG.md: the entry a branch adds, and the version it becomes.
 *
 * A branch writes its entry under `## Unreleased`. `make bump` moves that text
 * under `## vX.Y.Z — YYYY-MM-DD` in the release commit, so the entry merges
 * with the version it describes. CI checks that the entry is there, and
 * `make release` and `make pr` read it back out.
 *
 *   node scripts/changelog.mjs 1.3.0        # print the v1.3.0 entry
 *   node scripts/changelog.mjs --unreleased # print the pending entry
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHANGELOG = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

const UNRELEASED = /^## Unreleased\s*$/;

/** @typedef {{ heading: string, version: string | null, body: string }} Section */

/** Each `## ` section in order, with its body trimmed.
 *  @param {string} text
 *  @returns {Section[]} */
export function sections(text) {
  /** @type {{ heading: string, lines: string[] }[]} */
  const found = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^## (.+?)\s*$/);
    if (m) found.push({ heading: m[1] ?? "", lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  return found.map(({ heading, lines }) => ({
    heading,
    version: heading.match(/^v(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null,
    body: lines.join("\n").trim(),
  }));
}

/** The pending entry, or "" when there is none.
 *  @param {string} text @returns {string} */
export function unreleased(text) {
  return sections(text).find((s) => UNRELEASED.test(`## ${s.heading}`))?.body ?? "";
}

/** One version's entry, or null when the file has no section for it.
 *  @param {string} text @param {string} version @returns {string | null} */
export function entry(text, version) {
  return sections(text).find((s) => s.version === version)?.body ?? null;
}

/** The lines of `head` that `base` does not have, under the `###` group
 *  headings they sit in. `base` is the pending entry on main, so the result is
 *  the part of an entry that one branch wrote.
 *
 * @param {string} base
 * @param {string} head
 * @returns {string} */
export function added(base, head) {
  const seen = new Set(base.split("\n").map((l) => l.trim()).filter(Boolean));
  /** @type {{ heading: string | null, lines: string[] }[]} */
  const groups = [{ heading: null, lines: [] }];
  for (const line of head.split("\n")) {
    if (line.startsWith("### ")) groups.push({ heading: line, lines: [] });
    else if (line.trim() && !seen.has(line.trim())) groups.at(-1)?.lines.push(line);
  }
  return groups
    .filter((g) => g.lines.length)
    .map((g) => (g.heading ? `${g.heading}\n\n${g.lines.join("\n")}` : g.lines.join("\n")))
    .join("\n\n");
}

/** The file with the pending entry moved under a version heading. The
 *  `## Unreleased` heading stays, empty, for the next branch.
 *
 * @param {string} text
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @returns {string} */
export function stamp(text, version, date) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => UNRELEASED.test(l));
  if (start < 0) throw new Error("CHANGELOG.md has no '## Unreleased' heading");
  const next = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  const end = next < 0 ? lines.length : next;

  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) {
    throw new Error("CHANGELOG.md has nothing under '## Unreleased'; write this branch's entry there first");
  }
  if (entry(text, version) !== null) throw new Error(`CHANGELOG.md already has a v${version} section`);

  const head = lines.slice(0, start + 1).join("\n");
  const rest = lines.slice(end).join("\n").trimEnd();
  return `${head}\n\n## v${version} — ${date}\n\n${body}\n${rest ? `\n${rest}\n` : ""}`;
}

/** Whether the file describes a version that is about to ship: an entry for
 *  it, and nothing left pending.
 *
 * @param {string} text
 * @param {string} version
 * @returns {{ ok: boolean, why: string }} */
export function verifyEntry(text, version) {
  const body = entry(text, version);
  if (body === null) return { ok: false, why: `CHANGELOG.md has no v${version} section` };
  if (!body) return { ok: false, why: `the v${version} section of CHANGELOG.md is empty` };
  if (unreleased(text)) {
    return { ok: false, why: `CHANGELOG.md still has text under '## Unreleased', which v${version} would not carry` };
  }
  return { ok: true, why: `CHANGELOG.md has the v${version} entry` };
}

/** Today in UTC, the date a release heading carries.
 *  @returns {string} */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === "-h" || arg === "--help") {
    process.stdout.write("usage: node scripts/changelog.mjs <version> | --unreleased\n");
    process.exit(arg ? 0 : 1);
  }
  const text = readFileSync(CHANGELOG, "utf8");
  const body = arg === "--unreleased" ? unreleased(text) : entry(text, arg.replace(/^v/, ""));
  if (!body) {
    process.stderr.write(arg === "--unreleased" ? "nothing under '## Unreleased'\n" : `no entry for v${arg.replace(/^v/, "")}\n`);
    process.exit(1);
  }
  process.stdout.write(`${body}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
