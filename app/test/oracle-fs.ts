/* Reading the oracle dumps and the fixture WAVs off disk.
 *
 * Node tiers only. The browser tier gets the same cases through static imports
 * in oracle-data.ts, which Vite inlines at build time.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { OracleCase } from "./oracle";

/* Resolved by walking up from the working directory rather than from
   import.meta.url. The DOM tier runs modules through a dev server, so
   `import.meta.url` there is an http:// URL and fileURLToPath refuses it —
   which showed up as "The URL must be of scheme file" before a single test had
   run. The working directory is a file path in every tier. */
function findUp(rel: string): string {
  let at = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const candidate = join(at, rel);
    if (existsSync(candidate)) return candidate;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return join(resolve(process.cwd()), rel);
}

const ORACLE_DIR = findUp("app/test/oracle");
export const DATA_DIR = findUp("tests/data");

/** Every case named in the dump's own index. */
export function oracleCasesFromDisk(): OracleCase[] {
  const index = `${ORACLE_DIR}/index.json`;
  if (!existsSync(index)) {
    throw new Error(
      "No oracle dumps found. Run `npm run oracle` (needs the Python venv) " +
        "to regenerate them from tests/data.",
    );
  }
  const { cases } = JSON.parse(readFileSync(index, "utf8")) as { cases: string[] };
  return cases.map(
    (f) => JSON.parse(readFileSync(`${ORACLE_DIR}/${f}`, "utf8")) as OracleCase,
  );
}

/** The filenames the index lists, for checking the static list has them all. */
export function oracleIndexNames(): string[] {
  const { cases } = JSON.parse(
    readFileSync(`${ORACLE_DIR}/index.json`, "utf8"),
  ) as { cases: string[] };
  return cases.map((f) => f.replace(/\.json$/, ""));
}
