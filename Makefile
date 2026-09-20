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

# The drawing lives in app/public/favicon.svg and nowhere else. The .ico and
# the three PNG tiles are rasterisations of it, so they are generated rather
# than drawn — edited by hand they drift from the source and nothing notices.
#
# Not part of `build`: it needs librsvg and ImageMagick, which are not
# dependencies of the app, and the shape changes about once a year.
.PHONY: icons
icons: ## Rebuild the .ico and PNG tiles from app/public/favicon.svg
	node scripts/icons.mjs

# ---- releasing ------------------------------------------------------------ #

# The version moves on a branch, before the pull request, and CI only checks
# that it moved. Nothing in the pipeline can write to the repository — no token,
# no deploy key — which is only true because this step is a person's job.
#
# The bump comes from the branch you are standing on: feat/ is a minor, fix/
# and chore/ are patches.
.PHONY: bump\:dry
bump\:dry: ## Say what this branch would release, change nothing
	node scripts/version.mjs --dry-run --branch "$$(git rev-parse --abbrev-ref HEAD)"

.PHONY: bump
bump: ## Bump the version for this branch and commit it (run before the PR)
	node scripts/version.mjs --commit --branch "$$(git rev-parse --abbrev-ref HEAD)"

.PHONY: tag
tag: ## Tag the current version at HEAD (on main, after merging)
	@v=$$(node -p "require('./package.json').version"); \
		git tag -a "v$$v" -m "v$$v" && echo "tagged v$$v — \`git push --tags\` when you mean it"

# ---- housekeeping --------------------------------------------------------- #

.PHONY: clean
clean: ## Remove build output and node_modules
	rm -rf dist node_modules
