# File: Makefile
#
# The primary UX for the plan-file workflow.  `make help` (the default)
# lists the targets; `make populate` / `make update` are the two
# directions of the contract stated in the README.
#
# The app's targets (assets, assets-check, dev, build, test, check,
# browser-check, provenance-check) are at the end of this file.
#
# The engine (gh_project_*.py) has exactly one home — the
# williamdemeo/github-project repository — and this Makefile finds it
# through whichever channel is available, in order:
#
#   local     scripts/gh_project_populate.py exists in THIS tree — the
#             engine repository itself, or a template copy that has not
#             yet run `make init`
#   path      gh-project-* CLIs on PATH — a Nix dev shell with the
#             engine package (see templates/consumer/flake.nix), a
#             `nix profile install`, or a future pipx install
#   checkout  GHPROJECT_DIR points at a checkout of the engine repo
#
# Variables:
#   PLAN           plan file            (default: docs/GITHUB_PROJECT.md)
#   REPO           owner/name override  (default: the plan file's
#                                        **Repository**: header)
#   PYTHON         interpreter          (default: python3)
#   GHPROJECT_DIR  engine checkout path (checkout channel only)
#   NO_ENV_PREFIX  set (to anything) wherever gh authenticates *through*
#                  GH_TOKEN/GITHUB_TOKEN — GitHub Actions included; by
#                  default the engine strips those variables so they
#                  cannot shadow a keychain-stored token.

PYTHON ?= python3
PLAN   ?= docs/GITHUB_PROJECT.md
REPO   ?=
GHPROJECT_DIR ?=

FLAGS := $(if $(REPO),--repo $(REPO)) $(if $(NO_ENV_PREFIX),--no-env-prefix)

ifneq (,$(wildcard scripts/gh_project_populate.py))
  ENGINE_MODE := local
  POPULATE := $(PYTHON) scripts/gh_project_populate.py
  UPDATE   := $(PYTHON) scripts/gh_project_update.py
  LINT     := $(PYTHON) scripts/gh_project_lint.py
else ifneq (,$(shell command -v gh-project-update 2>/dev/null))
  ENGINE_MODE := path
  POPULATE := gh-project-populate
  UPDATE   := gh-project-update
  LINT     := gh-project-lint
else ifneq (,$(wildcard $(GHPROJECT_DIR)/scripts/gh_project_populate.py))
  ENGINE_MODE := checkout
  POPULATE := $(PYTHON) $(GHPROJECT_DIR)/scripts/gh_project_populate.py
  UPDATE   := $(PYTHON) $(GHPROJECT_DIR)/scripts/gh_project_update.py
  LINT     := $(PYTHON) $(GHPROJECT_DIR)/scripts/gh_project_lint.py
else
  ENGINE_MODE := missing
endif

.PHONY: help populate-dry populate update update-check lint init \
        guard-gh guard-engine engine-mode \
        assets assets-check dev build test check browser-check \
        provenance-check
.DEFAULT_GOAL := help

# In `path` mode the resolved CLI is (typically) a Nix wrapper carrying
# its own `gh` on a wrapped PATH, so probing the caller's ambient PATH
# would fail a `nix profile install` user whose tooling actually works;
# the CLI reports its own error if gh is genuinely absent.  local and
# checkout modes run bare python3 scripts and do need ambient gh.
ifeq ($(ENGINE_MODE),path)
GH_GUARD :=
else
GH_GUARD := guard-gh
endif

help: ## Show this help
	@grep -hE '^[a-zA-Z][a-zA-Z0-9_-]*:.*## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*## "} {printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'

populate-dry: guard-engine $(GH_GUARD) ## Preview what populate would create (no mutations)
	$(POPULATE) $(PLAN) $(FLAGS) --dry-run

populate: guard-engine $(GH_GUARD) ## Create labels, milestones, issues on GitHub from $(PLAN)
	$(POPULATE) $(PLAN) $(FLAGS)

update: guard-engine $(GH_GUARD) ## Rewrite $(PLAN)'s generated regions from live GitHub state
	$(UPDATE) $(PLAN) $(FLAGS)

update-check: guard-engine $(GH_GUARD) ## Report whether $(PLAN) is stale without writing
	$(UPDATE) $(PLAN) $(FLAGS) --check

lint: guard-engine ## Validate $(PLAN)'s structure (no network)
	$(LINT) $(PLAN)

init: ## Detach this template copy from the engine (one-time, consumer projects)
ifneq ($(ENGINE_MODE),local)
	@echo "Nothing to do: this tree carries no local engine copy."
else
	@echo "This removes the copied engine from this tree.  The engine's home is"
	@echo "https://github.com/williamdemeo/github-project; after this, make"
	@echo "resolves it from PATH (Nix dev shell) or GHPROJECT_DIR (checkout)."
	@if [ -z "$(INIT_YES)" ]; then \
	  printf 'Continue? [y/N] '; read ans; \
	  case "$$ans" in y|Y|yes) ;; *) echo "Aborted."; exit 1;; esac; \
	fi
	rm -f scripts/gh_project_populate.py scripts/gh_project_update.py \
	      scripts/gh_project_lint.py scripts/_gh_project_lib.py \
	      scripts/VERSION
	rm -rf scripts/_utils scripts/tests scripts/__pycache__
	@if [ -f templates/consumer/flake.nix ]; then \
	  mv templates/consumer/flake.nix flake.nix; \
	  rm -f flake.lock; \
	  rm -rf templates; \
	  echo "Installed the consumer flake (engine as a pinned input)."; \
	fi
	@echo
	@echo "Done.  Next steps:"
	@echo "  1. nix flake lock       # pin the engine (Nix channel), or set"
	@echo "     GHPROJECT_DIR to an engine checkout instead"
	@echo "  2. edit $(PLAN), then: make lint && make populate-dry"
	@echo "  3. commit the result"
endif

engine-mode: ## Print which engine channel this invocation resolved (debugging)
	@echo "$(ENGINE_MODE)"

guard-engine:
ifeq ($(ENGINE_MODE),missing)
	@echo "error: the github-project engine was not found.  Provide it via one of:"; \
	echo "  - Nix: enter the dev shell (nix develop) wired by your flake's"; \
	echo "    github-project input, so the gh-project-* CLIs are on PATH"; \
	echo "  - checkout: clone https://github.com/williamdemeo/github-project"; \
	echo "    and pass GHPROJECT_DIR=/path/to/that/clone"; \
	exit 1
endif

guard-gh:
	@command -v gh >/dev/null || { \
	  echo "error: the GitHub CLI (gh) is required for this target."; \
	  echo "       https://cli.github.com/  (or: nix develop)"; \
	  exit 1; \
	}

# ---------------------------------------------------------------------
# The app: its binaries, and the build
#
# Run these in the dev shell (`nix develop`), which carries node 22 and
# GNU coreutils.  The binaries the app ships are never committed.  The
# flake fetches each pinned one from upstream at the imported commit and
# checks it against its SHA-256 in $(PINS), and adds the files that are
# not upstream's: Agda's builtin library, agda-data.zip (`nix build
# .#agda-data`), the compiler's language server, its reactor build
# als-reactor-2.9.0.wasm with its glue als-reactor-2.9.0.js (`nix build
# .#compiler`, fetched by its pins in compiler/agda-2.9.0.sha256), and
# the standard library, agda-stdlib-2.3-patched.zip (`nix build
# .#stdlib`).  `make assets` copies the set into static/, and `make build`
# refuses to build unless every pinned file there still matches its pin
# and those four are the flake's.  (Inside the Nix sandbox, where `nix
# build .#site` runs the same `make build`, there is no nix to ask, and
# the site's derivation copies them in itself.)  docs/provenance.md
# records them all.  `make build` also publishes NOTICE (as NOTICE.txt)
# and licenses/ in build/.
#
# dev, build, test and check install the locked npm dependencies first
# (`npm ci`) when package.json or package-lock.json is newer than the
# last install.
#
#   PINS           the pinned binaries (default: upstream/assets.sha256)
#   UNCHANGED      the imported files that are still upstream's, byte for
#                  byte                (default: upstream/unchanged.sha256)
#   SITE           the built site browser-check serves, which must exist
#                  (default: build, from `make build`)
#   SITE_REVISION  what names the build: SvelteKit's kit.version.name and
#                  the commit vite.config.js records (default: the
#                  commit, with -dirty when the tree differs from it; the
#                  flake passes its own, since its sandbox has no .git)

PINS      ?= upstream/assets.sha256
# The files in static/ that are the flake's own (built, or pinned by
# compiler/agda-2.9.0.sha256) rather than upstream's.
OWN_ASSETS := agda-data.zip als-reactor-2.9.0.wasm als-reactor-2.9.0.js \
              agda-stdlib-2.3-patched.zip
UNCHANGED ?= upstream/unchanged.sha256
SITE_REVISION ?= $(shell rev=$$(git rev-parse HEAD 2>/dev/null) && \
  if [ -n "$$(git status --porcelain 2>/dev/null)" ]; then echo $$rev-dirty; else echo $$rev; fi)

# npm ci writes node_modules/.package-lock.json, so this reinstalls only
# after the manifest or the lockfile changes.
node_modules/.package-lock.json: package.json package-lock.json
	npm ci

assets: ## Fetch the pinned binaries, build the flake's own (nix build .#assets) into static/
	@out=$$(nix build .#assets --no-link --print-out-paths) && \
	  for f in static/*.wasm static/*.wasm.gz static/als-*.js static/*.zip; do \
	    if [ -e "$$f" ] && [ ! -e "$$out/$$f" ]; then \
	      rm "$$f" && echo "assets: removed $$f, which the set no longer has"; \
	    fi; \
	  done && \
	  cp -R --no-preserve=mode,ownership "$$out"/static/. static/ && \
	  echo "assets: copied $$out/static into static/"
	@$(MAKE) --no-print-directory assets-check

assets-check: ## Check the pinned binaries in static/, and that the flake's own files there are its
	@sha256sum --check --strict --quiet $(PINS) && \
	  echo "assets-check: all $$(grep -c . $(PINS)) pinned files match"
	@if command -v nix > /dev/null; then \
	  built=$$(nix build .#assets --no-link --print-out-paths) || exit 1; \
	  for f in $(OWN_ASSETS); do \
	    if cmp -s "$$built/static/$$f" "static/$$f"; then \
	      echo "assets-check: static/$$f is the flake's"; \
	    else \
	      echo "assets-check: static/$$f is not the flake's ($$built); run make assets" >&2; \
	      exit 1; \
	    fi; \
	  done; \
	fi

dev: node_modules/.package-lock.json assets-check ## Serve the app at http://localhost:5173, reloading on change
	npm run dev

build: node_modules/.package-lock.json assets-check ## Build the site into build/, after checking the pins
	SITE_REVISION=$(SITE_REVISION) npm run build
	install -m 644 NOTICE build/NOTICE.txt
	cp -R licenses build/licenses

test: node_modules/.package-lock.json ## Run the app's unit tests (vitest)
	npm test

check: node_modules/.package-lock.json ## Type-check the app (svelte-check)
	npm run check

SITE ?= build

browser-check: ## Check Main.agda in $(SITE), served isolated, in headless Chromium
	nix run .#browser-check -- $(SITE) --out browser-check

provenance-check: ## Check the unchanged files, and that docs/provenance.md lists every pin
	@sha256sum --check --strict --quiet $(UNCHANGED) && \
	  echo "provenance-check: all $$(grep -c . $(UNCHANGED)) unchanged files match upstream"
	@awk 'NR == FNR { while (match($$0, /[0-9a-f]{64}/)) { seen[substr($$0, RSTART, 64)] = 1; \
	                                                       $$0 = substr($$0, RSTART + 64) }; next } \
	      !($$1 in seen) { print "provenance-check: " $$2 " is pinned but not in docs/provenance.md"; bad = 1 } \
	      END { exit bad }' docs/provenance.md $(PINS) && \
	  echo "provenance-check: docs/provenance.md lists all $$(grep -c . $(PINS)) pins"
