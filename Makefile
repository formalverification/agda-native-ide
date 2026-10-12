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
        browser-check-notices provenance-check packages \
        conformance-native conformance-browser conformance-compare
# The companion's targets are separate from the browser app's gates.

.PHONY: vscode-check vscode-build vscode-test vscode-unit
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

# The repository is an npm workspace (issue 62): the page at the root, the
# shared packages under packages/, and the companion in vscode/, installed
# together from the one package-lock.json.  npm ci writes
# node_modules/.package-lock.json, so this reinstalls only after a
# manifest or the lockfile changes.
WORKSPACE_MANIFESTS := package.json package-lock.json vscode/package.json \
  $(wildcard packages/*/package.json)
node_modules/.package-lock.json: $(WORKSPACE_MANIFESTS)
	npm ci

# The shared packages TypeScript builds (packages/*/dist), in the order
# their project references give: the engine, then the tool surface and
# the manifest, which import it.  The views are Svelte source, which the
# page compiles.
PACKAGES := packages/engine packages/tools packages/manifest

packages: node_modules/.package-lock.json ## Build the shared packages (the engine, the tools, the manifest)
	npx tsc -b $(PACKAGES)

# The companion imports the engine and the tool surface, so it builds them
# first; scripts/build.mjs bundles it (issue 64).
vscode-check: packages ## Type-check the VS Code companion
	npm --workspace vscode run check

vscode-build: packages ## Bundle the VS Code companion, with the engine and the tool surface
	npm --workspace vscode run build

vscode-unit: vscode-build ## Check version policy and serialized state
	npm --workspace vscode run test:unit

vscode-test: vscode-check vscode-unit ## Run the real companion and Agda mode under Xvfb (nix develop .#vscode)
	timeout 300s npm --workspace vscode test

# ---------------------------------------------------------------------
# The engine's conformance suite (issue 62): one suite, two runners, each
# against a real Agda.  conformance-native runs it under node against the
# native agda that AGDA names (nix develop .#vscode sets it, at the
# compiler's own Agda commit); conformance-browser builds the harness page
# (scripts/conformance/browser/) and runs it in headless Chromium against
# $(SITE)'s reactor, served without the isolation headers;
# conformance-compare compares the two runs' answers field by field.  Each
# writes its record into $(CONFORMANCE).

CONFORMANCE ?= conformance
CONFORMANCE_HARNESS := .build-tmp/conformance-harness

conformance-native: packages ## Run the engine's conformance suite against native Agda (nix develop .#vscode)
	timeout 600s node scripts/conformance/native.mjs --out $(CONFORMANCE)

conformance-browser: packages ## Run the engine's conformance suite in headless Chromium against $(SITE)
	CONFORMANCE_OUT=$(abspath $(CONFORMANCE_HARNESS)) npx vite build \
	  --config scripts/conformance/browser/vite.config.js
	timeout 600s nix run .#conformance-browser -- $(SITE) \
	  --harness $(CONFORMANCE_HARNESS) --out $(CONFORMANCE)

conformance-compare: packages ## Compare the browser's and the native engine's answers, field by field
	node scripts/conformance/compare.mjs $(CONFORMANCE)/browser.json $(CONFORMANCE)/native.json

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
# (`npm ci`) when a workspace manifest or package-lock.json is newer than
# the last install, and build the shared packages (`make packages`).
#
#   PINS           the pinned binaries (default: upstream/assets.sha256)
#   UNCHANGED      the imported files that are still upstream's, byte for
#                  byte                (default: upstream/unchanged.sha256)
#   SITE           the built site browser-check serves, which must exist
#                  (default: build, from `make build`)
#   ISOLATED       set (to anything) to serve it with the two headers that
#                  make it cross-origin isolated, which the page no longer
#                  needs, and assert that it is (default: without them)
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

dev: packages assets-check ## Serve the app at http://localhost:5173, reloading on change
	npm run dev

build: packages assets-check ## Build the site into build/, after checking the pins
	SITE_REVISION=$(SITE_REVISION) npm run build
	node scripts/check-bundle.mjs build
	install -m 644 NOTICE build/NOTICE.txt
	cp -R licenses build/licenses

test: packages ## Run the unit tests of the app and the packages (vitest)
	npm test

check: packages ## Type-check the app and the packages (svelte-check, tsc)
	npm run check
	npx svelte-check --tsconfig $(abspath packages/views/tsconfig.json) --workspace packages/views

SITE ?= build

browser-check: ## Check Main.agda in $(SITE) in headless Chromium (ISOLATED=1: with the isolation headers)
	nix run .#browser-check -- $(SITE) \
	  $(if $(ISOLATED),--isolated --out browser-check/isolated,--out browser-check)

browser-check-notices: ## Check $(SITE)'s notices: a browser it cannot run in, a compiler that fails
	nix run .#browser-check-notices -- $(SITE) --out browser-check/notices

provenance-check: ## Check the unchanged files, and that docs/provenance.md lists every pin
	@sha256sum --check --strict --quiet $(UNCHANGED) && \
	  echo "provenance-check: all $$(grep -c . $(UNCHANGED)) unchanged files match upstream"
	@awk 'NR == FNR { while (match($$0, /[0-9a-f]{64}/)) { seen[substr($$0, RSTART, 64)] = 1; \
	                                                       $$0 = substr($$0, RSTART + 64) }; next } \
	      !($$1 in seen) { print "provenance-check: " $$2 " is pinned but not in docs/provenance.md"; bad = 1 } \
	      END { exit bad }' docs/provenance.md $(PINS) && \
	  echo "provenance-check: docs/provenance.md lists all $$(grep -c . $(PINS)) pins"
