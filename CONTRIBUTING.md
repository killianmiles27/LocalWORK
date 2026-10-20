# Contributing

Start with a small issue or pull request that explains the problem and expected behavior. Include a reproduction for bugs. Keep unrelated formatting and refactors out of the change.

Build prerequisites are in [docs/SETUP.md](docs/SETUP.md). The frontend is React/TypeScript; the host is Rust/Tauri; the workbench tools are Python. Windows x64 is the tested platform. A model is not needed for most unit tests.

```powershell
npm ci
npm run build
npm run test:workspace
python -m pip install -r workbench-mcp/requirements-web.txt
python -m unittest discover -s scripts/tests -p 'test_*.py'
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml
```

Browser lifecycle and app acceptance tests need the pinned runtime resources:

```powershell
python scripts/tests/browser_windows.py
python scripts/e2e/check-agent-context.py --work ../.e2e-runs
python scripts/e2e/check-agent-long-turn.py --work ../.e2e-runs
node scripts/tests/thinking.browser.mjs
pwsh -NoProfile -File scripts/e2e/run-all.ps1 -Exe ./src-tauri/target/release/localwork.exe -Only T-A1,T-A2,T-C1 -Iterations 1 -KeepWork
```

The acceptance harness uses isolated data and a tiny model stub by default. Passing it does not establish the real model's reasoning quality. Do not use personal documents, credentials, or live servers as fixtures. Report skipped checks and benchmark failures honestly.

Dependency checks: `npm audit`, `cargo audit --file src-tauri/Cargo.lock`, and `pip-audit -r workbench-mcp/requirements-web.txt --no-deps --disable-pip`. Install audit tools separately from the app runtime. Preserve lockfiles and license notices when updating dependencies. Do not disable signature or checksum checks to make a build pass.

Agent changes belong in the pinned patch and build script, not an untracked edited executable. See [vendor/README.md](vendor/README.md). Model-specific setup belongs in Strata; keep general agent instructions independent of any benchmark website.

Contributions are accepted under Apache-2.0. Keep third-party copyright and license notices intact. Report security issues through [SECURITY.md](SECURITY.md), rather than a public exploit report.
