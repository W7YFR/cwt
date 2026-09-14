# cwt — a browser CW keying trainer.
#
# It records, decodes, grades and draws, entirely in the browser. Everything
# under app/src is the product; app/test holds three test tiers and the
# recordings they run against.

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_\\:-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS="## "}{t=$$1; sub(/:[ \t].*$$/,"",t); gsub(/\\/,"",t); \
			printf "  \033[36m%-14s\033[0m %s\n", t, $$2}'

node_modules: package.json ## (internal) install JS dependencies
	npm install
	@touch node_modules

.PHONY: dev
dev: node_modules ## Run the app with hot reload at localhost:5173
	npm run dev

.PHONY: build
build: node_modules ## Build the app into dist/
	npm run build

# Two ways to look at it, and the difference is whether it moves under you.
# `serve` is a snapshot: dist/ as it was last built, unaffected by edits to the
# source until you ask for a new one. `dev` is the opposite and `serve:latest`
# is the bridge — rebuild, then serve the result.
.PHONY: serve
serve: ## Serve the last build at localhost:4173
	@test -f dist/index.html || { echo "No build in dist/ — run 'make serve:latest'"; exit 1; }
	npm run preview

.PHONY: serve\:latest
serve\:latest: build ## Build, then serve it at localhost:4173
	npm run preview

.PHONY: browsers
browsers: node_modules ## Download the browser the third test tier needs (once)
	npx playwright install chromium

# ---- tests ---------------------------------------------------------------- #

.PHONY: test
test: node_modules ## Pure + DOM test tiers
	npm test

.PHONY: test-browser
test-browser: node_modules ## The real-Chromium tier (needs `make browsers`)
	npm run test:browser

.PHONY: test-all
test-all: test test-browser ## Every tier, including the browser one

.PHONY: lock
lock: node_modules ## Re-record what the DSP says about clean audio (deliberate!)
	@echo "→ re-recording app/test/lock/clean-path.json"
	npm run lock --silent
	@echo "✓ recorded. Review the diff: it is a diff in what users get."

.PHONY: typecheck
typecheck: node_modules ## Typecheck without emitting
	npm run typecheck

# ---- housekeeping --------------------------------------------------------- #

.PHONY: clean
clean: ## Remove build output and node_modules
	rm -rf dist node_modules
