# cw-decoder — setup, test, and global install.

PYTHON  ?= python3
VENV    := .venv
BIN     := $(VENV)/bin
LOCALBIN := $(HOME)/.local/bin

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

$(BIN)/python: ## (internal) create the virtualenv
	$(PYTHON) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip >/dev/null

.PHONY: venv
venv: $(BIN)/python ## Create the virtualenv

.PHONY: dev
dev: venv ## Editable install + test and live-capture deps into the venv
	$(BIN)/pip install -e ".[test,live]" \
		|| $(BIN)/pip install -e ".[test]" \
		|| $(BIN)/pip install -e . pytest

.PHONY: test
test: dev ## Run the round-trip test suite
	$(BIN)/python -m pytest -q

.PHONY: demo
demo: dev ## Decode a synthesized signal end-to-end
	$(BIN)/cw-decode --demo "CQ CQ DE W1AW K" --demo-wpm 22 --demo-farnsworth 13

.PHONY: install
install: venv ## Install into the venv and expose `cw-decode` on your PATH
	$(BIN)/pip install -e ".[live]" || $(BIN)/pip install -e .
	mkdir -p $(LOCALBIN)
	ln -sf "$(abspath $(BIN)/cw-decode)" "$(LOCALBIN)/cw-decode"
	@echo ""
	@echo "Installed: $(LOCALBIN)/cw-decode -> $(abspath $(BIN)/cw-decode)"
	@command -v cw-decode >/dev/null 2>&1 \
		&& echo "Ready: run  cw-decode ~/some/file.wav" \
		|| echo "NOTE: add $(LOCALBIN) to your PATH, then run  cw-decode <file>"

.PHONY: uninstall
uninstall: ## Remove the global symlink
	rm -f "$(LOCALBIN)/cw-decode"
	@echo "Removed $(LOCALBIN)/cw-decode (venv left intact; 'make clean' to remove it)"

.PHONY: clean
clean: ## Remove the venv and build artifacts
	rm -rf $(VENV) build dist src/*.egg-info *.egg-info
