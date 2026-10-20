# LocalWORK project context

## Product and boundaries

Windows x64 Tauri 2 host, React/TypeScript UI, Strata model server, pinned aionrs conversation agent, Python workbench MCP, and OfficeCLI/Playwright tools. This is early software. README.md, docs/SETUP.md and docs/USAGE.md are the user-facing entry points; SECURITY.md defines trust boundaries. There is no OS sandbox or complete browser network isolation.

## Paths and setup

Runtime resources are beside an installed executable or discovered up the development build tree. User settings/data live in %LOCALAPPDATA%/Workbench. Strata/model files remain external. Saved strataRoot/modelConfig values take priority over optional LOCALWORK_STRATA_ROOT/LOCALWORK_MODEL_CONFIG defaults; no developer paths are embedded. The first-run Wizard and Settings both select paths. Model config is trusted executable input.

Use npm ci, scripts/fetch-vendor.ps1, scripts/build-agent.ps1, and scripts/install-mcp-libs.ps1 with the selected Strata Python. Build releases through `npm run tauri -- build --no-bundle`; a plain Cargo release can retain the dev URL. Vendor executables are ignored by Git. Manifest/lockfiles/pins are tracked. Local deployment backs up replacements and verifies copied hashes; it does not touch model files or user data.

## Entry points

- src/App.tsx: conversations, streaming/tool events, approval controls, context ring, Files panel.
- src/Settings.tsx and src/Wizard.tsx: paths, model lifecycle, hardware overview, optional SSH, presentation settings.
- src/Workspace.tsx and src-tauri/src/documents.rs: previews, file opening/export, revision history. Resolve existing paths canonically within a chat folder; reject ADS and reparse traversal. HTML previews are approximate and sandboxed; PDFs open externally.
- src-tauri/src/agent.rs: one child agent per chat; JSONL protocol, MCP registration, message queue, approval dispatch, revision capture.
- src-tauri/src/strata.rs: authenticated loopback service launch/ownership/readiness/telemetry.
- src-tauri/src/policy.rs and sshpolicy.rs: conservative action classification. Unknown or complex read-only forms ask; Automatic mode allows ordinary work. OfficeCLI positional and secondary paths need classification before read shortcuts. This remains a heuristic, not shell isolation.
- src-tauri/src/plugins.rs, runconfig.rs; src/ModeSwitcher.tsx, StatusItems.tsx, SettingsModel.tsx: declarative plugins (modes, skills, prompt text, MCP servers, status items), mode/effort switching and the run-config editor. See docs/PLUGINS.md. Machine-specific launch profiles live in a user plugin, never in app/.
- src/BrowserLive.tsx: live browser view (peek card plus Files-panel view with step thumbnails) from screenshots the browser tool saves per chat.
- workbench-mcp/server.py: tool schemas/dispatch and Office verification bundle. public_web.py validates and IP-pins fetches including redirects, with byte/time bounds. browser.py drives background Chromium; navigation DNS checks and hostname globs do not constrain every page subrequest.

## Invariants

- Single-instance plugin setup completes before stale-process cleanup, Job Object initialization, rollback or database opening. Otherwise launching a second copy can terminate a live model.
- The host serializes agent messages, including /context. Upstream can drop requests delivered concurrently. Approval answers and Stop bypass this queue.
- Stop has a bounded graceful shutdown and then kills only that agent's tree. Stale readers cannot remove its replacement. Completed file operations are not undone.
- Context usage is a projection, never the sum of every request's usage. Unknown stays unknown. An internal /context stream ending does not finish the UI's active user turn.
- The host merges managed compact settings with toml_edit, preserving unrelated user config. Trigger is 80% of the actual window. A health capability opts the OpenAI-compatible agent into Strata /v1/chat/compact for both manual and automatic compaction; otherwise the generic checkpoint remains available. Native replacement is transactional: preserve leading instructions, exact recent turn/tool groups and their session metadata; errors/cancellation never fall back to history-dropping summaries. Runtime system/tool overhead and reply capacity count toward the context limit. No-op results do not create a compaction boundary.
- Automatic mode defaults on and persists across chats/restarts. Explicit dangerous/consequential actions still ask. Browser eval labels are descriptions, not authoritative action classification.
- Cross-chat memory injection is disabled. Do not advertise automatic personalization from the legacy memory table.
- Browser is headless. Long snapshots and errors have recoverable workspace files. Retain clickable refs even when labels are absent. No website-specific skill is shipped; examples/recipes under scripts/e2e are test fixtures only.
- officecli verify bundles validate/issues/outline/text and ordinary DOCX stats. Results remain individually labelled; errors and truncation are unresolved. DOCX --page-count is opt-in, Word-dependent, and bounded 20s. File validity does not establish content/rubric quality.
- Interactive HTML uses opaque-origin iframe sandboxing, bounded messages and explicit composer review for follow-ups. Keep src/intelligent-ui.ts, SandboxedUi.tsx and Tauri frame CSP paired. Do not replay old show_document calls when reopening a chat.
- Direct supported edits preserve previous file revisions; arbitrary shell edits do not. Canonical Windows paths must be normalized to native DOS/UNC spelling at OfficeCLI/Explorer boundaries; extended prefixes can miss resident Office sessions.
- Current Office previews are editable by default; historical previews are read-only. The source-bound sandbox bridge handles selections and document-only zoom. Workspace tracks focus, queued saves and edit generations so delayed previews cannot replace local edits.
- App batches successful pane saves by chat and element, debounces dependency checks, and dispatches them through the existing agent message path when that chat is selected, idle and model-ready. Before/after text is labelled as untrusted data; the agent must reread project files and update only supported relationships. Failed sends retain the batch for a new edit, successful message or model-ready transition; they do not retry in a loop. This in-memory mechanism is neither a persistent dependency graph nor an external-file watcher.
- OfficeCLI accepts a separate `commands` array with `args: ["batch", target]`. Short batches use native `--commands`; large UTF-16 command lines use a closed UTF-8 input file under workspace `.localwork-tmp`, removed in finally. Legacy `--input` calls remain compatible. The file picker skips hidden `.*.build.json` scratch names without deleting them or hiding general JSON documents.
- Updater supports signed raw Windows installer EXEs. ZIP extraction is disabled to remove an unnecessary vulnerable dependency. Forks need their own signing key and endpoint. Rollback currently restores the executable and cannot guarantee matching old resources.

- Plugins are data only: no code is injected into the UI or host. Status sources are an allowlist (`HOST_SOURCES`) of read-only commands. A manifest that fails to parse is listed as *Not loaded* with its error, never silently dropped. Only one model instance runs; a mode switch with reload restarts the owned Strata process.
- Loop guards live in server.py and the system prompt together: load_skill dedupes per chat (force:true reloads); identical idempotent calls (web_search, web_fetch, read_attachment, memory_search) return a short note on the 2nd call and a refusal from the 3rd; all tool output is capped at 24,000 characters. Errors are not counted.
- The brand mark is defined in three places that must stay in step: scripts/make-icons.py (icons), public/icon.svg and src/Logo.tsx. The mark carries no letters, so a rename does not need new art.

## Checks

See CONTRIBUTING.md for commands and docs/PUBLIC_READINESS.md for the latest audit. Most tests need no GPU. Windows browser tests require pinned Chromium; CDP acceptance uses isolated app data and stub inference by default. A guided website run or stub suite is not a broad real-model benchmark. Do not hide timed-out or skipped model trials.

After substantial changes, update this file with architecture/invariants only. Keep transcripts, local filesystem inventories, private logs, hardware benchmark artifacts and deployment backup paths outside Git.
