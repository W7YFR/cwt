/* The dev server has to be able to reach its own socket.
 *
 * index.html says `connect-src 'none'`, which is the truth about the app and a
 * lie about the dev server: hot updates arrive over a WebSocket to localhost,
 * and a browser enforcing that policy blocks it. The symptom is not an error
 * anyone goes looking for — the page loads, the app works, and edits simply do
 * not appear until you reload by hand, which reads as hot reloading having
 * been switched off rather than as a policy doing its job.
 *
 * So: the served page must let the socket through, and the built page must
 * not. Both halves, because either one alone is a regression waiting to be
 * made — the first was, once.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import config from "../../../vite.config";
import { DATA_DIR } from "../oracle-fs";

const INDEX = readFileSync(`${DATA_DIR}/../../index.html`, "utf8");

/** The policy the browser would enforce.
 *
 * Read off the tag rather than off the page, because the prose above the tag
 * quotes the directives it is explaining — and the difference between the two
 * is the entire bug this file is about, on both sides of it: a rewrite that
 * hit the comment switched the policy off, and an assertion that reads the
 * comment cannot tell a fixed page from a broken one. */
function policy(html: string): string[] {
  const tag = html.match(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0];
  if (!tag) throw new Error("no Content-Security-Policy meta tag in index.html");
  return tag
    .match(/content="([^"]*)"/)![1]!
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
}

/** The plugin under test, found the way vite finds it. */
function devCsp() {
  const plugins = ((config as { plugins?: unknown[] }).plugins ?? []).flat(9);
  const found = plugins.find(
    (p): p is { name: string; apply?: string; transformIndexHtml(html: string): string } =>
      typeof p === "object" && p !== null && (p as { name?: string }).name === "dev-csp",
  );
  if (!found) throw new Error("no dev-csp plugin in the vite config");
  return found;
}

describe("the app's own content policy", () => {
  it("shuts every outbound connection in the page that ships", () => {
    // The premise, and worth asserting on its own: the loosening below is only
    // safe because this is what the file says.
    expect(policy(INDEX)).toContain("connect-src 'none'");
  });

  it("is loosened for the dev server, and only there", () => {
    const p = devCsp();
    expect(p.apply).toBe("serve");
    const served = policy(p.transformIndexHtml(INDEX));
    expect(served).not.toContain("connect-src 'none'");
    expect(served.find((d) => d.startsWith("connect-src"))).toMatch(/\bws:/);
  });

  it("loosens that one directive and nothing else", () => {
    /* A policy edited by pattern is a policy that can be edited by too much.
       The first version of this plugin matched the comment above the tag and
       swallowed the tag into it, which turned the whole policy off in dev
       while looking like it had done the small thing. */
    const before = policy(INDEX);
    const after = policy(devCsp().transformIndexHtml(INDEX));
    expect(after.length).toBe(before.length);
    expect(before.filter((d, i) => d !== after[i])).toEqual(["connect-src 'none'"]);
  });

  it("passes a page with no policy through untouched", () => {
    /* The test runner serves its own page, and it has no policy to loosen.
       Nothing to do there is not the same as something being wrong, and a
       warning in every browser-tier run is noise that teaches people to read
       past warnings. */
    const bare = "<!doctype html>\n<html><head><title>x</title></head><body></body></html>";
    expect(devCsp().transformIndexHtml(bare)).toBe(bare);
  });

  it("leaves the tag where it was, and the page around it alone", () => {
    /* Same length of document either way, give or take the directive itself:
       a rewrite that ate a comment or a tag would show up here as a page that
       lost a paragraph. */
    const served = devCsp().transformIndexHtml(INDEX);
    const grew = served.length - INDEX.length;
    expect(grew).toBe("connect-src 'self' ws: wss:".length - "connect-src 'none'".length);
    expect(served.match(/<meta/g)!.length).toBe(INDEX.match(/<meta/g)!.length);
  });
});
