# LocalWORK handoff for the next coding agent

## Where things live (read this first)
| Place | Role |
| --- | --- |
| GitHub `killianmiles27/LocalWORK` | **Master copy.** Point a coding agent here (or at the local clone below). |
| `C:\Random\Working Folder\LocalWORKpp` | The local git clone and the source you edit. This folder is the repo root. The rest of `Working Folder\LocalWORK` (the `strata` model engine, benchmark notes, spec documents) is NOT part of the repo. |
| `C:\Random\LocalWORK` | Only the **built app** the user runs. Never edit here; it is overwritten on every redeploy. |

Rebuild and redeploy after a change:
1. `cd "C:\Random\Working Folder\LocalWORKpp"`, then `npm run build` and `npx tauri build --no-bundle` (never plain `cargo build --release`).
2. Close LocalWORK. Copy `src-tauri	argetelease\localwork.exe` to `C:\Random\LocalWORK\LocalWORK.exe`, `workbench-mcp\*.py` to `C:\Random\LocalWORK\workbench-mcp\`, and `skills\` to `C:\Random\LocalWORK\skills\`.
3. Commit and push to `main`.

Read this first. It lists what already exists (do not re-add it), where it lives, how to build and test, and what is known to be broken or untested. Spec: `docs/implementation-spec.md`. Model/engine contract: `docs/MODEL-HANDOFF.md`. Design decisions: `docs/decisions.md`. Third-party notices: `NOTICE.md`.

## What it is
A Windows desktop "AI coworker" app: Tauri 2 (Rust) shell + WebView2, React 19/Vite/Tailwind 4 UI. Everything runs offline on the user's PC. The model is served by **Strata** (separate folder, OpenAI-compatible server). The agent loop is the vendored **aionrs** (`--json-stream`), which talks to Strata and to our own **workbench MCP** (Python). The user picks a workspace folder per chat; the agent works on files in it.

## Layout
| Path | What |
| --- | --- |
| `src/App.tsx` | Chat UI: sidebar, streaming, approval cards, attachments (button, paste, drag-drop), memory chips, voice button |
| `src/Rich.tsx` | In-chat renderers: chart (bar/line/pie SVG), sortable table, diagram, sandboxed artifact iframe, plan checklist. `richFor(toolName,args)` is called from `Row` in App.tsx |
| `src/Settings.tsx` | Settings: model/system info (CPU/RAM/VRAM/TPS), memory list, SSH hosts, Versions (rollback), App |
| `src/voice.ts`, `src-tauri/src/voice.rs` | Push-to-talk voice (whisper.cpp) |
| `src-tauri/src/lib.rs` | App entry, Tauri commands, single instance, updater plugin, state |
| `src-tauri/src/agent.rs` | Spawns aionrs per conversation, builds system prompt (`system-prompt.md` + skill list + memories), routes events, calls `policy::decide`, stores messages |
| `src-tauri/src/policy.rs` | Approval policy (info/edit/exec/mcp categories, workspace boundary, protected paths, browser rules). Allow-list of read-only MCP tools is in `mcp_decision` |
| `src-tauri/src/sshpolicy.rs` | SSH command classifier (read-only auto-allow only for hosts with "read ok"; unit-tested) |
| `src-tauri/src/ssh.rs` | SSH host store, key generation, host-key scan/pin commands |
| `src-tauri/src/strata.rs` | Starts/stops/health-checks Strata (hidden, ephemeral port, key in memory) |
| `src-tauri/src/supervisor.rs` | Windows Job Object, `pids.json` stale-process reaping |
| `src-tauri/src/store.rs` | SQLite (conversations, messages, memories + FTS5) |
| `src-tauri/src/rollback.rs` | Saves each version's exe to `%LOCALAPPDATA%\Workbench\rollback`, backs up the db before a new version first runs (`backups/`), `rollback_to` swaps the exe and restarts |
| `workbench-mcp/server.py` | MCP tools: officecli, web_search, web_fetch, memory_*, load_skill, browser, workspace_info, read_attachment, ssh_exec, show_chart, show_table, show_diagram, publish_artifact, update_plan |
| `workbench-mcp/{web,browser,memory,attachments,ssh}.py` | Tool implementations. Third-party Python libs go in `workbench-mcp/libs` (gitignored; `scripts/install-mcp-libs.ps1`) |
| `skills/<name>/SKILL.md` | Skills auto-listed in the system prompt and loaded with `load_skill`: academic-docx, coding, officecli-basics, pptx-deck, research, ssh-admin, verify-document, xlsx-model |
| `vendor/` + `vendor/manifest.json` + `scripts/fetch-vendor.ps1` | Pinned binaries (aionrs, officecli, node, playwright, chromium, whisper); fetched, not committed |
| `scripts/e2e` | Test helpers |

## Features that already exist (do not re-add)
- Chat with streaming, stick-to-bottom scroll, thinking display, stop button, conversations list, delete, auto-titles.
- Blue theme, light/dark, redesigned UI; Settings panel with model name/quant, CPU/RAM/VRAM, tokens/sec.
- Approval policy with cards ("Allow once", "Allow for this chat", "Deny"); mode "Ask before editing" vs "Edits allowed in folder"; protected locations denied outright (e.g. `C:\Windows`).
- Persistent memory (`memory_save/search/forget`), "Remembered" chip with Undo, memory list in Settings.
- Office work via OfficeCLI (docx/xlsx/pptx) with skills and recipes; system prompt guidance.
- Web search/fetch (results wrapped as untrusted), a browser tool (Playwright, per-project login sessions, private addresses blocked, consequential clicks ask).
- Attachments: attach button, paste, drag-drop; agent reads them with `read_attachment` (pdf/docx/xlsx/pptx/csv/text/html).
- Voice input.
- SSH admin: `ssh_exec` tool, hosts + key + fingerprint-pinned known_hosts in Settings, read-only auto-allow per host, everything else asks, output wrapped untrusted, `ssh-admin` skill.
- Charts, tables, diagrams, sandboxed artifacts (opaque origin + CSP, no network), plan view.
- First-run wizard (`src/Wizard.tsx`, `src-tauri/src/setup.rs`): hardware check (GPU, driver, RAM, disk), Strata folder check/choice, default projects folder, web access on/off (off makes `policy.rs` deny browser/web_search/web_fetch).
- Strata update check in Settings > Model engine: looks first (`git fetch`), shows what changed, and only updates (runs `UPDATE.bat`, restarts the model) after a confirm click.
- Document check loop: the `verify-document` skill (validate, issues, outline, text, stats, fix, repeat up to 3 rounds). Text views only: officecli screenshot/pdf modes hang here (no browser or Word), so they are told not to be used.
- Updater (signed NSIS), single instance, Job Object cleanup, version rollback and db backup.

## Build, run, test
```powershell
cd app
npm install
powershell scripts\fetch-vendor.ps1          # vendor binaries, pinned in vendor\manifest.json
powershell scripts\install-mcp-libs.ps1      # python libs for the MCP (uses Strata's .venv python)
npm run build                                 # vite
npx tauri build --no-bundle                   # exe at src-tauri\target\release\localwork.exe
```
IMPORTANT: use `npx tauri build`, not plain `cargo build --release`: the latter produces an exe that points at the dev server (`localhost:1420`) and shows a blank page.

Deploy layout (what the user runs): `C:\Random\LocalWORK\` has `LocalWORK.exe`, `vendor\`, `workbench-mcp\*.py` (+ `libs`), `skills\`. After a rebuild copy the exe, `workbench-mcp\*.py` and `skills\` there.

Unit tests: `cd src-tauri; cargo test` (includes the SSH classifier). UI tests: launch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"` and drive the page over CDP (click, set textarea via the native value setter + `input` event, click "Allow once" by innerText). Test workspace: `C:\Users\you\Documents\lw-test`.

## Strata launch (see docs/MODEL-HANDOFF.md, authoritative)
`server.py` + `selected-model.json` in the Strata folder; explicit `--host`/`--port` (ephemeral), no `--open`, API key in env `STRATA_API_KEY` (kept in memory, never logged, committed or sent to the frontend); readiness is verified on the protected `/v1/models` (`/health` is open). Context 32768, kv int8. The model takes 60 to 90 s to be ready. Default Strata path is in `paths.rs` (`DEFAULT_STRATA_ROOT`, overridable by `strataRoot` in settings.json).

## Release and signing
See `docs/release.md`. Updater key: `C:\Users\you\.tauri\localwork.key` (NEVER commit; public key is in `tauri.conf.json`). Bump version in `tauri.conf.json` and `Cargo.toml`, `npm run tauri -- build`, upload setup exe, `.sig` and `latest.json` to a GitHub Release. Installer is unsigned for Authenticode (SmartScreen warns).

## Verified in the real app (this build)
Chat, approvals, memory, skills loading, web, browser, attachments (xlsx, pptx, docx), charts, tables, diagrams, artifact iframe, plan view, rollback copy and db backup written on first run. Security tests: T-S1 (injection in an attached file was reported, not obeyed), T-S2 (write to `C:\Windows` refused, file absent), T-S3 (single localhost listener, unauthenticated `/v1/models` returns 401), T-S4 (artifact `fetch` and `window.parent` both blocked), logs contain no key/Authorization text.

## Known gaps, untested, not built
- **SSH live test (B8) not run**: no test server (WSL cannot start here: Hyper-V missing). Classifier is unit-tested; the Settings SSH panel was written but not exercised end to end.
- **Rollback**: the Versions panel and exe swap are written; actually clicking "Roll back to version" with a second version was not tested (only one version exists). Restoring a db backup is manual (`backups\`); the spec's `app.db.bak-<version>` naming differs from ours (`workbench.db`, `workbench-from-<ver>-<ts>.db`).
- T-S1 was tested with an attached file, not a fetched web page. T-S5/T-S6 only spot-checked (T-S6 not run).
- Benchmarks B1 to B7 and B9 were not run as a suite; T-L1 to T-L7 and the 8 hour soak were not run as a suite (the model answered live document tasks in several sessions, but no long soak) (cleanup logic exists and was checked by hand earlier).
- The Strata update apply path (`strata_update_apply`) was deliberately not run live, to avoid changing the working engine. The check step was verified.
- Not built: pixel-level document rendering (see above), citation registry, `search_files` tool, an Activity view beyond the plan checklist, Authenticode signing.
- The diagram layout is a simple layered layout (no crossing minimisation); charts are hand-rolled SVG (no zoom).
- Tooling quirk: when editing regex-heavy Rust/Python with shell heredocs, backslashes can get mangled. Check for stray `\x08`; prefer a file-writing tool.

## House rules
No model identifiers in repo artifacts. Commit as the repo author with a `Co-Authored-By` trailer. Do not commit `libs`, `vendor` binaries or any key.
