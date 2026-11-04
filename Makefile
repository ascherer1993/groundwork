.PHONY: setup dev browser build cli test e2e lint fmt bindings

setup: ## Install JS dependencies and the Playwright browser
	cd app && npm ci && npx playwright install webkit

dev: cli ## Desktop app with hot reload
	cd app && npm run tauri dev

browser: cli ## UI in a normal browser (http://localhost:1420) against the real backend
	cd app && npm run dev:browser

build: ## Release .app bundle
	cd app && npm run tauri build

cli: ## Build the `groundwork` CLI and the `groundworkd` terminal daemon next to the app ("Set up Claude Code…" links the CLI onto PATH)
	cargo build -q -p groundwork-cli -p groundwork-terminal-daemon

bindings: ## Regenerate TypeScript API types from Rust
	cargo test -q -p groundwork-core -p groundwork-protocol export_bindings

test: ## Rust + frontend unit tests
	cargo test --workspace --all-features
	cd app && npm test

e2e: ## Playwright tests in browser mode (WebKit)
	cd app && npm run e2e

lint: ## Everything CI would check
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --all-features -- -D warnings
	cd app && npm run typecheck && npm run lint

fmt:
	cargo fmt --all
	cd app && npm run format
