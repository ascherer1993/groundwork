.PHONY: setup dev browser build install cli test e2e lint fmt bindings perf

setup: ## Install JS dependencies and the Playwright browser (Rust comes from rustup, https://rustup.rs)
	cd app && npm ci && npx playwright install webkit

# `make dev` runs the app through scripts/dev-app, which starts it inside a
# "Groundwork Dev.app" bundle so macOS shows its notifications.
HOST := $(shell rustc -vV | sed -n 's/^host: //p')

# An Intel Rust (Homebrew's, on a Mac whose Homebrew is the Intel one) builds
# an Intel app that runs under Rosetta. Rust from rustup is native.
ifeq ($(shell uname -m),arm64)
ifneq ($(filter x86_64-%,$(HOST)),)
$(error $(shell which rustc) is an Intel build of Rust. Install Rust with rustup (https://rustup.rs), remove the other one (brew uninstall rust), and open a new terminal)
endif
endif
DEV_RUNNER := CARGO_TARGET_$(shell echo $(HOST) | tr 'a-z-' 'A-Z_')_RUNNER

dev: cli ## Desktop app with hot reload
	cd app && $(DEV_RUNNER)="$(CURDIR)/scripts/dev-app" npm run tauri dev

browser: cli ## UI in a normal browser (http://localhost:1420) against the real backend
	cd app && npm run dev:browser

# Signs with your Developer ID if you have one, else your Apple Development
# certificate, else ad hoc ("-"). SIGNING_IDENTITY="…" picks another.
identity = $(shell security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\($(1):.*\)"/\1/p' | head -1)
SIGNING_IDENTITY ?= $(or $(call identity,Developer ID Application),$(call identity,Apple Development),-)
BUNDLE := target/release/bundle/macos/Groundwork.app

build: ## Release Groundwork.app (target/release/bundle/macos), signed; the CLI, daemon and Claude Code plugin inside
	cargo build -q --release -p groundwork-cli -p groundwork-terminal-daemon
	mkdir -p app/src-tauri/binaries
	cp target/release/groundwork app/src-tauri/binaries/groundwork-$(HOST)
	cp target/release/groundworkd app/src-tauri/binaries/groundworkd-$(HOST)
	cd app && APPLE_SIGNING_IDENTITY="$(SIGNING_IDENTITY)" npm run tauri build -- --config src-tauri/tauri.bundle.conf.json
	codesign --verify --deep --strict "$(BUNDLE)"
	@echo "Built $(BUNDLE), signed as: $(SIGNING_IDENTITY)"

install: build ## Build, then put Groundwork.app in /Applications (replacing the one there)
	rm -rf /Applications/Groundwork.app
	ditto "$(BUNDLE)" /Applications/Groundwork.app

cli: ## Build the `groundwork` CLI and the `groundworkd` terminal daemon next to the app ("Set up Claude Code…" links the CLI onto PATH)
	cargo build -q -p groundwork-cli -p groundwork-terminal-daemon

bindings: ## Regenerate TypeScript API types from Rust
	cargo test -q -p groundwork-core -p groundwork-protocol export_bindings

test: ## Rust + frontend unit tests
	cargo test --workspace --all-features
	cd app && npm test

e2e: ## Playwright tests in browser mode (WebKit)
	cd app && npm run e2e

# A made-up vault of 10,000 notes (scripts/make-big-vault), made the first time.
PERF_VAULT ?= $(TMPDIR)groundwork-big-vault

perf: ## Time the backend's requests on a big made-up vault
	@test -d "$(PERF_VAULT)" || scripts/make-big-vault "$(PERF_VAULT)" --notes 10000
	GROUNDWORK_QMD=/nonexistent cargo run -q --release -p groundwork-backend --example perf -- "$(PERF_VAULT)"

lint: ## Everything CI would check
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --all-features -- -D warnings
	cd app && npm run typecheck && npm run lint

fmt:
	cargo fmt --all
	cd app && npm run format
