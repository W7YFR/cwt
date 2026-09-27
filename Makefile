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

# The microphone is offered to secure contexts only, so a phone on the LAN —
# which reaches this machine by address, not as localhost — gets no microphone
# at all over plain http. This issues a certificate from a local authority and
# serves over https so a real device can be tested without deploying anything.
# One-time setup, printed by the script: `brew install mkcert nss`,
# `mkcert -install`, then trust the same authority on the phone.
.PHONY: dev-device
dev-device: node_modules ## Run with https on the LAN, so a phone can use the mic
	npm run dev:device

# The authority is the machine's, not this project's: every other project that
# has run `mkcert -install` trusts it too. So this asks before removing it, and
# refuses outright unless the path mkcert reports really is a CA directory —
# the documented `rm -rf "$$(mkcert -CAROOT)"` is a silent no-op when mkcert is
# missing, which tells you the CA is gone while your devices still trust it.
.PHONY: uninstall\:cert
uninstall\:cert: ## Remove the dev certificate, and the local CA behind it
	node scripts/devcert.mjs --uninstall

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

# Write the branch's entry under `## Unreleased` in CHANGELOG.md first. The
# bump moves it under the new version, and the lines this branch wrote become
# the PR body. A branch that releases nothing keeps its entry under
# Unreleased, and takes its title from the branch name, or TITLE.
.PHONY: pr
pr: ## Bump, push, and open or update this branch's PR (TITLE="..." for no-release)
	node scripts/pr.mjs $(if $(TITLE),--title "$(TITLE)")

.PHONY: tag
tag: ## Tag the current version at HEAD (on main, after merging)
	@v=$$(node -p "require('./package.json').version"); \
		git tag -a "v$$v" -m "v$$v" && echo "tagged v$$v — \`git push origin v$$v\` when you mean it"

# Pushes the one new tag, not every local tag the way `git push --tags` does.
# The tag message and the GitHub release notes are the version's CHANGELOG.md
# entry. `--cleanup=whitespace` keeps its `###` headings, which git strips as
# comments by default.
# A merge that changed no build input kept the version, so it gets no tag.
# Run from a branch, it stops unless that branch's pull request is merged.
# Run from main, it offers the branch that main's last merge names.
# It offers the delete only when main contains the branch. `git branch -d`
# alone is not enough: it also deletes a branch that its upstream contains,
# and `make pr` sets an upstream.
.PHONY: release
release: ## After merging: update main, tag and push its version, delete the branch
	@set -e; \
	git diff --quiet HEAD || { echo "Uncommitted changes — commit or stash first"; exit 1; }; \
	branch=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$branch" != main ]; then \
		state=$$(gh pr view "$$branch" --json state --jq .state 2>/dev/null) \
			|| { echo "No pull request found for $$branch — open one with 'make pr', or run this from main"; exit 1; }; \
		[ "$$state" = MERGED ] || { echo "The pull request for $$branch is $$state, not merged — merge it first"; exit 1; }; \
	fi; \
	git switch main; \
	git pull --ff-only; \
	v=$$(node -p "require('./package.json').version"); \
	if git rev-parse -q --verify "refs/tags/v$$v" >/dev/null; then \
		echo "v$$v is already tagged; main has no new version to release"; \
	else \
		notes=$$(node scripts/changelog.mjs "$$v" 2>/dev/null || true); \
		printf 'v%s\n\n%s\n' "$$v" "$$notes" | git tag -a "v$$v" --cleanup=whitespace -F -; \
		git push origin "v$$v"; \
		if [ -n "$$notes" ]; then \
			printf '%s\n' "$$notes" | gh release create "v$$v" --verify-tag --title "v$$v" --notes-file - \
				|| echo "tagged v$$v, but the GitHub release failed; retry with gh release create"; \
		fi; \
	fi; \
	if [ "$$branch" = main ]; then \
		branch=$$(node --input-type=module -e 'import { branchFromMerge } from "./scripts/version.mjs"; console.log(branchFromMerge(process.argv[1]) ?? "")' "$$(git log -1 --format=%s)"); \
	fi; \
	if [ -n "$$branch" ] && [ "$$branch" != main ] && git show-ref -q --verify "refs/heads/$$branch"; then \
		if ! git merge-base --is-ancestor "$$branch" main; then \
			echo "$$branch is not merged into main; kept"; \
			exit 0; \
		fi; \
		printf "Delete local branch %s? [Y/n] " "$$branch"; \
		read -r answer; \
		case "$$answer" in \
			[nN]*) echo "kept $$branch" ;; \
			*) git branch -d "$$branch" ;; \
		esac; \
	fi

# ---- housekeeping --------------------------------------------------------- #

.PHONY: clean
clean: ## Remove build output and node_modules
	rm -rf dist node_modules
