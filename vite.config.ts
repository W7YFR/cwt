import { fileURLToPath, URL } from "node:url";
/* From vitest rather than vite: the `test` key below is vitest's, and only
   vitest's defineConfig knows the type of it. */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
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
export default defineConfig({
  root: "app",
  // Overridden at deploy time: GitHub Pages serves a project site from
  // /<repo>/, so the base has to match or every asset 404s.
  base: process.env.PUBLIC_BASE ?? "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./app/src", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
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
          include: ["src/**/*.browser.test.ts", "test/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
