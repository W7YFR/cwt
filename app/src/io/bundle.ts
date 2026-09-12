/* Loading a recording that something else prepared.
 *
 * This is how `cw-decode --serve` hands a session to the app: it writes a
 * bundle — one JSON file naming one audio file — into a directory, serves that
 * directory alongside the built app, and opens a browser at it. The app checks
 * for the bundle on boot and goes straight to the review instead of showing the
 * landing screen.
 *
 * Deliberately the same `Take` the app builds for itself. The CLI does the DSP
 * in Python and the browser does it in TypeScript, but from the segments
 * onward there is exactly one implementation, so a session reviewed either way
 * is graded by the same code.
 */

import type { Take } from "@/types";

/** What a bundle file contains. */
export interface Bundle {
  /** Bumped when the shape changes in a way an older app could not read. */
  version: number;
  take: Take;
  /** Relative URL of the recording, served beside the bundle. */
  audioUrl: string;
}

export const BUNDLE_VERSION = 1;
export const BUNDLE_PATH = "take.json";

export interface LoadedBundle {
  take: Take;
  audio: ArrayBuffer;
}

function looksLikeTake(value: unknown): value is Take {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<Take>;
  return (
    typeof t.id === "string" &&
    typeof t.rate === "number" &&
    Array.isArray(t.segments) &&
    !!t.measured &&
    typeof t.measured.unitSec === "number"
  );
}

/** Fetch the bundle beside the page, or null if there isn't one.
 *
 * Null is the ordinary case — the deployed app is opened directly and has no
 * bundle — so a missing file is not an error and must not surface as one. A
 * malformed one *is* an error, because somebody meant to hand us something.
 *
 * Telling those two apart takes more than a status code. Both the Vite dev
 * server and our own serve.py answer an unknown path with index.html and a
 * 200, because in a single-page app an unknown path is a route rather than a
 * missing file. So a bundle that simply is not there arrives as a perfectly
 * successful response full of HTML, and parsing it as JSON reports a corrupt
 * bundle on every `npm run dev`. The content type is what actually
 * distinguishes them. */
export async function loadBundle(
  path = BUNDLE_PATH,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedBundle | null> {
  let response: Response;
  try {
    response = await fetchImpl(path, { cache: "no-store" });
  } catch {
    // Offline, or a file:// page where fetch is blocked outright. Either way
    // there is nothing to load and the landing screen is the right answer.
    return null;
  }
  if (!response.ok) return null;

  // An HTML answer is the single-page fallback: there is no bundle here.
  const contentType = response.headers.get("content-type") ?? "";
  if (/\bhtml\b/i.test(contentType)) return null;

  const text = await response.text();
  // Belt and braces, for a server that serves the fallback with no useful
  // content type at all.
  if (/^\s*<(?:!doctype|html)\b/i.test(text)) return null;

  let bundle: Bundle;
  try {
    bundle = JSON.parse(text) as Bundle;
  } catch {
    throw new Error(`${path} is not readable JSON`);
  }

  if (!looksLikeTake(bundle?.take)) {
    throw new Error(`${path} does not contain a recording this app can read`);
  }
  if (bundle.version > BUNDLE_VERSION) {
    throw new Error(
      `${path} was written by a newer version of the tool (bundle v${bundle.version}); ` +
        "update the app, or re-export from this one.",
    );
  }

  const audioUrl = bundle.audioUrl || "";
  if (!audioUrl) throw new Error(`${path} names no audio file`);
  // Resolved against the bundle, so a bundle in a subdirectory still finds its
  // own audio rather than looking for it at the site root.
  const resolved = new URL(audioUrl, new URL(path, window.location.href)).href;

  const audioResponse = await fetchImpl(resolved, { cache: "no-store" });
  if (!audioResponse.ok) {
    throw new Error(`could not read the recording at ${audioUrl}`);
  }

  return { take: bundle.take, audio: await audioResponse.arrayBuffer() };
}
