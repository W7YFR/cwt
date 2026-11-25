/* The terms page and its version. An edit to the terms without a raise of
 * TERMS_VERSION would leave each agreement standing for terms nobody agreed
 * to. Each version's page has its hash here, so that edit fails. */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TERMS_VERSION } from "@/terms";

/** The SHA-256 of `app/public/terms.html` at each terms version. */
const HASHES: Record<number, string> = {
  1: "60a818a827ad54d0b0196f81f165347a47e1b483e67d28892c96e5c80154aa46",
};

describe("the terms", () => {
  it("raise TERMS_VERSION with each change to terms.html", () => {
    const page = readFileSync(fileURLToPath(new URL("../../public/terms.html", import.meta.url)));
    const hash = createHash("sha256").update(page).digest("hex");
    expect(hash, `terms.html changed: raise TERMS_VERSION in app/src/terms.ts and add ${TERMS_VERSION + 1}: "${hash}" here`).toBe(HASHES[TERMS_VERSION]);
  });
});
