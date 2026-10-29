## Summary

<!-- What changed and why? -->

## Tests

Check the commands you ran. For anything skipped or not applicable, say why. See [CONTRIBUTING.md](../CONTRIBUTING.md) for prerequisites and details.

- [ ] `npm run build`
- [ ] `npm run test:workspace`
- [ ] `python -m unittest discover -s scripts/tests -p 'test_*.py'`
- [ ] `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml`
- [ ] `python scripts/tests/browser_windows.py`
- [ ] `python scripts/e2e/check-efficient-tools.py --work ../.e2e-runs`
- [ ] `python scripts/e2e/check-agent-context.py --work ../.e2e-runs`
- [ ] `python scripts/e2e/check-agent-long-turn.py --work ../.e2e-runs`
- [ ] `python scripts/e2e/check-agent-python.py --work ../.e2e-runs --python '<configured-python>'`
- [ ] `python scripts/e2e/check-agent-recovery.py --work ../.e2e-runs --python '<configured-python>' --officecli vendor/officecli.exe --scenario output-limit --scenario repeated-reasoning --scenario always-truncated --scenario unfinished-plan`
- [ ] `node scripts/tests/thinking.browser.mjs`
- [ ] `node scripts/tests/plan.browser.mjs`
- [ ] `node scripts/tests/model-picker.browser.mjs`
- [ ] `pwsh -NoProfile -File scripts/e2e/run-all.ps1 -Exe ./src-tauri/target/release/localwork.exe -Only T-A1,T-A2,T-C1 -Iterations 1 -KeepWork`
