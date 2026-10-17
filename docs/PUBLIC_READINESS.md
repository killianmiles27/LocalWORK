# Public-readiness audit

Reviewed 17 October 2026, starting from commit `811c4f9`. This records a source/code review, dependency scans, and local verification. It is not a penetration-test certification or a guarantee that no bugs remain.

## Publication assessment

The source is prepared for public review as an **early Windows x64 project**. It now has a root Apache-2.0 license, dependency notices, setup and usage documentation, configurable runtime paths, regression tests, and a pinned GitHub Actions workflow. Publishing source is separate from announcing a production-ready app or distributing an installer.

Before a binary release, test the actual installer on a clean Windows account or VM, run the new workflow on GitHub, review the final redistribution artifacts and any source-availability obligations, and confirm signing/update recovery. No clean-VM, cross-GPU, or broad real-model workflow certification was performed in this pass.

## Changes made

- Removed developer-specific Strata/model defaults. Users select both paths in the wizard or Settings; environment defaults are optional. Invalid configuration selections preserve the previous settings.
- Repaired approval bypasses involving PowerShell expressions, shell overrides, mutating Git flags, SSH command prefixes, OfficeCLI positional/secondary output paths, and named fields shadowing actual operands. Unknown/complex read-only commands ask. Automatic mode still permits ordinary work.
- Hardened web fetching: public-address checks, IP-pinned connections with original TLS hostname verification, redirect validation, no environment proxies, download limits, and shared fetch time budget. Added deterministic tests and a successful public HTTPS smoke test.
- Removed false claims of complete browser private-network blocking or universal offline operation. The browser remains headless; it is not network isolation.
- Removed an unused vulnerable ZIP updater dependency; signed raw Windows installer EXEs remain supported.
- Updated the agent's vulnerable HTTP/QUIC/TLS dependencies through a tracked, reproducible lockfile patch, then rebuilt and tested it. Its key is now passed through the child environment rather than the command line.
- Pinned the browser npm tree and Python dependencies; improved bootstrap checks, error handling, reuse, and environment cleanup. Added license collection with pinned upstream provenance.
- Corrected setup hardware claims, added later model reconfiguration and web controls, fixed the web-toggle UI behavior found by acceptance testing, and shortened stale machine-specific handoff documents.

## Verification performed

| Check | Result |
| --- | --- |
| Gitleaks 8.24.2: reachable Git history | No secrets detected |
| Gitleaks: pending public-source snapshot | No secrets detected |
| Frontend npm audit | No known vulnerabilities |
| Browser-tool npm audit | No known vulnerabilities |
| Pinned Python dependency audit | No known vulnerabilities |
| Host Cargo.lock audit | No known vulnerabilities; upstream informational warnings remain |
| Patched agent Cargo.lock audit | No known vulnerabilities; unsafe-libyaml maintenance warning remains |
| App Rust library tests | 21 passed; one optional Office integration test ignored |
| Agent compaction tests | 102 passed |
| Python tool regression suite | 19 passed |
| Frontend TypeScript/Vite build | Passed |
| Interactive-preview sandbox tests | 3 passed, including real Chromium isolation checks |
| Windows browser lifecycle | Passed; no browser or console window appeared |
| Rebuilt agent JSONL context protocol | Automatic and manual compaction passed |
| CDP app checks | Automatic persistence, Stop/resume, context UI, portable setup and web controls passed |
| License inventory strict check | Passed for collected component sets; see third-party/README.md |
| Rust Clippy | Completed with five style warnings; not a warning-free lint baseline |

The initial portable-setup test caught a delayed controlled-checkbox update. That bug was fixed and the test passed on the rebuilt executable. Acceptance uses isolated app data and deterministic inference; it does not assess real model reasoning. The final Stop/resume check used the security-updated agent with a matching resource hash.

Host audit warnings for `glib` and `proc-macro-error` concern packages present in the cross-platform lockfile; neither appears in the Windows target dependency tree. The agent's `unsafe-libyaml` maintenance warning is retained openly. Advisory databases change, so rerun the audits before a release.

## Remaining boundaries

- Tools execute with the user's OS permissions. Approval checks are not a shell or filesystem sandbox. Automatic mode is enabled by default.
- Hostile browser page subrequests are not completely isolated from private networks. Use a separate account or VM for sensitive/untrusted browsing.
- Chats, logs, caches, and browser profiles are not encrypted by LocalWORK. Local history may contain personal material.
- In-app rollback archives executables, not a complete matching resource tree. Keep known-good full installers; do not promise seamless cross-version rollback.
- Real model performance, compaction retention, final Office pagination, AMD configurations, and other machines still need broader testing. Earlier guided browser tests do not establish general task success.
- The new CI workflow is checked in and its commands were exercised locally, but it has not yet run remotely for these pending changes. Keep signing secrets out of PR workflows.

## Repository hygiene

The current docs no longer contain the developer's filesystem inventory. Historical commits still contain old machine paths and benchmark notes; no history rewrite was performed. The scans found no credentials, but they cannot prove absence of every possible secret. Review history yourself if those historical details are private to you.

Generated models, executables, app data, local settings, audit reports, and test/deployment work folders stay out of Git. Model weights used by Strata have separate licenses and are not redistributed here. Repository visibility and release publication were not changed by this audit.
