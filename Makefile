# cw-trainer — the browser app, and the CLI that feeds it.
#
# Two halves with one analysis between them. The TypeScript app in app/ is the
# product: it records, decodes, grades and draws, entirely in the browser. The
# Python package in src/ is the command-line recorder and the oracle the port
# is held to — it does its own DSP and hands the *segments* to the app, so the
# grading exists in exactly one place.

PYTHON  ?= python3
VENV    := .venv
BIN     := $(VENV)/bin
LOCALBIN := $(HOME)/.local/bin

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---- the browser app ------------------------------------------------------ #

node_modules: package.json ## (internal) install JS dependencies
	npm install
	@touch node_modules

.PHONY: dev
dev: node_modules ## Run the app with hot reload at localhost:5173
	npm run dev

.PHONY: build
build: node_modules ## Build the app into dist/
	npm run build

.PHONY: browsers
browsers: node_modules ## Download the browser the third test tier needs (once)
	npx playwright install chromium

# ---- tests ---------------------------------------------------------------- #

.PHONY: test
test: test-js test-py ## Run everything that does not need a browser download

.PHONY: test-js
test-js: node_modules ## Pure + DOM test tiers
	npm test

.PHONY: test-browser
test-browser: node_modules ## The real-Chromium tier (needs `make browsers`)
	npm run test:browser

.PHONY: test-py
test-py: dev-py ## The CLI and its DSP
	$(BIN)/python -m pytest -q

.PHONY: test-all
test-all: test test-browser ## Every tier, including the browser one

.PHONY: verify
verify: dev-py node_modules ## Re-derive the oracle from Python and hold the port to it
	@echo "→ regenerating the oracle from the Python decoder"
	$(BIN)/python tools/oracle.py app/test/oracle
	@echo "→ checking the TypeScript port against it"
	npx vitest run --project pure
	@echo "✓ the port still agrees with the reference implementation"

.PHONY: lock
lock: node_modules ## Re-record what the DSP says about clean audio (deliberate!)
	@echo "→ re-recording app/test/lock/clean-path.json"
	npm run lock --silent
	@echo "✓ recorded. Review the diff: it is a diff in what users get."

.PHONY: typecheck
typecheck: node_modules ## Typecheck without emitting
	npm run typecheck

# ---- the CLI -------------------------------------------------------------- #

$(BIN)/python: ## (internal) create the virtualenv
	$(PYTHON) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip >/dev/null

.PHONY: venv
venv: $(BIN)/python ## Create the virtualenv

.PHONY: dev-py
dev-py: venv ## Editable install + test deps into the venv
	@$(BIN)/python -c "import cw_decoder" 2>/dev/null || \
		$(BIN)/pip install -e ".[test]" || $(BIN)/pip install -e . pytest

.PHONY: demo
demo: dev-py build ## Decode a synthesized signal and open the review
	$(BIN)/cw-decode --demo "CQ CQ DE W1AW K" --demo-wpm 22 --demo-farnsworth 13 \
		-w 22 -f 13 -e "CQ CQ DE W1AW K"

.PHONY: install
install: venv ## Install the CLI and expose `cw-decode` on your PATH
	$(BIN)/pip install -e .
	mkdir -p $(LOCALBIN)
	ln -sf "$(abspath $(BIN)/cw-decode)" "$(LOCALBIN)/cw-decode"
	@echo ""
	@echo "Installed: $(LOCALBIN)/cw-decode -> $(abspath $(BIN)/cw-decode)"
	@command -v cw-decode >/dev/null 2>&1 \
		&& echo "Ready: run  cw-decode  (then key into your input device)" \
		|| echo "NOTE: add $(LOCALBIN) to your PATH, then run  cw-decode"

.PHONY: uninstall
uninstall: ## Remove the global symlink
	rm -f "$(LOCALBIN)/cw-decode"
	@echo "Removed $(LOCALBIN)/cw-decode (venv left intact; 'make clean' to remove it)"

# ---- housekeeping --------------------------------------------------------- #

.PHONY: clean
clean: ## Remove build output, the venv, and node_modules
	rm -rf $(VENV) build dist node_modules src/*.egg-info *.egg-info
