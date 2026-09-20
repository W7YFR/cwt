import { fileURLToPath, URL } from "node:url";
/* From vitest rather than vite: the `test` key below is vitest's, and only
   vitest's defineConfig knows the type of it. */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
/* The provider is a package rather than a string: vitest moved each browser
   driver out into its own, so naming one in the config is also what pulls it
   in. */
import { playwright } from "@vitest/browser-playwright";

/* Three test tiers, because the app has three kinds of code and only the first
   kind is cheap to test:

     *.test.ts          pure. No DOM, no Web Audio, no environment at all —
                        just functions over typed arrays and plain objects.
                        Most of the value lives here and it runs in
                        milliseconds.
     *.dom.test.tsx     React against jsdom: controls, markup, wiring.
     *.browser.test.ts  real Chromium. jsdom has no canvas (getContext returns
                        null) and no Web Audio whatsoever, so anything touching
                        those cannot be faked into meaning anything.

   The tier is chosen by filename rather than by directory, so a module can
   have a pure test for its math and a browser test for its rendering without
   being split in two.

   `npm test` runs pure + dom, because those need no browser download. The
   browser tier is `npm run test:browser` and needs `npx playwright install
   chromium` once. */
/* The dev server's own socket, through the app's CSP.
 *
 * index.html declares `connect-src 'none'` — the app talks to nothing, ever,
 * and the policy says so rather than leaving it to be inferred. That is true
 * of the app and false of the dev server, whose hot-update channel is a
 * WebSocket to localhost: the browser blocks it, the client logs "connecting"
 * forever, and every edit sits on the server until the page is reloaded by
 * hand. It reads exactly like hot reloading having been turned off.
 *
 * So the loosening lives here rather than in the HTML, and `apply: "serve"`
 * is the whole point of it: the built page keeps the policy it was written
 * with, and no shipped byte knows this plugin exists. */
function devCsp(): Plugin {
  const OPEN = "connect-src 'self' ws: wss:";
  /* The tag first, the directive inside it second. The prose above the tag
     quotes the directive it is explaining, so a pattern loose enough to find
     `connect-src` anywhere in the page finds the comment instead — and
     rewriting THAT swallowed the tag into the comment, which switched the
     whole policy off in dev while looking like it had done the small thing.
     The policy is full of single quotes, so the tag is matched as a tag rather
     than by trying to spell an attribute value that contains them. */
  const META = /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i;
  return {
    name: "dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      const tag = html.match(META)?.[0];
      // A page with no policy at all is not the app's — the test runner serves
      // its own — and has nothing to loosen. Not a problem, so not a warning.
      if (!tag) return html;
      if (!/connect-src/.test(tag)) {
        // A policy that no longer names the directive, on the other hand, is
        // this plugin quietly doing nothing. Silence there would be a dev
        // server that mysteriously stops hot-reloading again.
        console.warn("[dev-csp] no connect-src in the page policy — HMR may be blocked");
        return html;
      }
      return html.replace(tag, tag.replace(/connect-src[^;"]*/, OPEN));
    },
  };
}

export default defineConfig({
  root: "app",
  // Relative, so the build works at the domain root or under any subpath —
  // one page, no router, nothing to resolve against wrongly.
  base: "./",
  plugins: [react(), devCsp()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./app/src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    // Off: the site is public and the source is on GitHub, so shipping .map
    // files next to the bundle adds weight without adding anything readable
    // that a reader could not already get from the repo.
    sourcemap: false,
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "pure",
          environment: "node",
          include: ["src/**/*.test.ts", "test/pure/**/*.test.ts"],
          exclude: ["src/**/*.dom.test.*", "src/**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./test/setup-dom.ts"],
          include: ["src/**/*.dom.test.{ts,tsx}", "test/dom/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          setupFiles: ["./test/setup-browser.ts"],
          include: ["src/**/*.browser.test.ts", "test/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            /* The microphone granted up front, because otherwise this tier
               boots into the one screen that exists to ask for it. A fresh
               Chromium answers the permission query with "prompt", the landing
               page correctly offers "Grant Mic Access" instead of a record
               button, and every test that used the record button as its way of
               saying "we are on the landing screen" fails for a reason that has
               nothing to do with what it was testing.

               Granted is also the honest setting: it is the state the app
               spends all of its life in. The screen before it is covered in the
               dom tier, where the browser can be made to withhold the names on
               purpose. */
            provider: playwright({
              contextOptions: { permissions: ["microphone"] },
            }),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
