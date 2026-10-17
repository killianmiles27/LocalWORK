# LocalWORK project context

## Agent reliability and automatic mode

- Source is this `app` repository; `C:\Random\LocalWORK` is the installed copy.
  Build through Tauri and use `scripts/deploy-local.ps1` to back up and update it.
  Local edits and deployment do not automatically commit or push to GitHub.
- `auto_edit` KV now represents global Automatic mode, defaults on, persists
  across restarts, and applies to existing/new agents. Routine workspace edits and
  browser evaluation proceed automatically; recognized destructive actions,
  credential entry, uploads, external submissions and SSH changes retain checks.
  Policy is action classification, not an OS or JavaScript security sandbox.
  Browser eval descriptions are not action labels; classify the script itself.
  Command path checks consume quoted Windows paths with spaces as a whole and
  distinguish UNC starts from repeated separators inside a drive path.
  Routine PowerShell/cmd wrappers are allowed in Automatic mode; the wrapper
  itself does not establish a consequential action. Encoded commands still ask.
- Context usage is the agent's approximate projection, never the sum of a turn's
  request usages. Internal `/context` stream endings are not UI turn endings.
  `context_usage` events refresh the ring directly; unknown measurements stay
  unknown. During a turn the UI labels the measurement as the prior value.
  The host serializes all message commands: upstream drops messages arriving
  while another message (including `/context`) is active. Approvals/Stop bypass
  this queue. Stop allows a bounded graceful shutdown, then kills only that
  agent's process tree. Old readers cannot remove a replacement agent.
- Managed compact keys are merged with `toml_edit` into valid project TOML,
  preserving unrelated settings and accepting inline/quoted tables. This crate
  already exists in Tauri's dependency graph. Trigger is 80% of the real window.
  Read/parse/write failures are surfaced. Strata starts with `--fit-max-tokens`:
  summary requests have a separate output allowance from ordinary replies.
  Fitting reduces output allowance only, never truncates the input.
- Single-instance plugin setup must complete before process cleanup, job setup,
  rollback, database initialization and model startup. Builder `.plugin()` alone
  does not run plugin setup; moving these before `.setup()` can kill a live model
  on a second launch.
- Scenic canvas/image/toggle/frost layers are removed. Browser sessions use
  bundled headless Chromium with separate app profiles; no user-visible window.
  The earlier visible-browser behavior was removed at the user's request. The
  Windows console-hiding preload remains. CLI code echoes are removed from tool
  results; clipped snapshots remain readable at `.browser/snapshot-latest.yml`.
  `find`/`snapshot <ref>` support targeted inspection. `wait <seconds>` is a bounded
  0–30 second delay followed by a snapshot (the CLI has no native wait command).
- No website-specific agent guide is shipped. The earlier Gapminder skill was
  removed at the user's request; its recipe lives only in
  `scripts/e2e/fixtures/gapminder-recipe.md` for the deterministic browser probe.
  That probe does not evaluate general model reasoning. Earlier full assignment
  runs loaded the special guide and must be labelled guided evaluations.
- General instructions favor labelled controls, targeted observations, changing
  failed approaches, stopping research once claims are supported, and durable
  task notes. Research no longer mandates a fixed count of queries/pages.
  Academic formatting guidance is general, without the example assignment's
  numeric limits. These changes are research-informed hypotheses, not proof of
  improved model performance. Sources: Anthropic's
  [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  and [tool design](https://www.anthropic.com/engineering/writing-tools-for-agents).

Focused checks: Rust library tests, `python scripts/tests/test_browser_output.py`,
`python scripts/tests/browser_windows.py`, and
`python scripts/e2e/check-agent-context.py --work ../.e2e-runs` (bundled agent +
tiny HTTP model). CDP groups `T-A1`/`T-A2`/`T-C1` verify Automatic persistence,
actual first send/Stop/resume, and context rendering. The stub supplies a slow
stream for the Stop check; agent and MCP processes are real.
`-RealStrata -Only T-G1 -KeepWork` submits the saved Gapminder prompt
through the actual composer and preserves transcript/screenshots/output; a
presented file still requires content, citation, word-count and figure review.
The harness isolates WebView2 profile data as well as LOCALAPPDATA.
The earlier guided real-model run `lw-e2e-1e7bde83` delivered a draft after two successful
compactions with zero approvals, but timed out at 25 minutes waiting for the final
reply. Its file QA found 257 narrative words in two paragraphs and an embedded
full trail; naming, figure formatting and final citation/layout review remain.
Do not equate a delivered file with a complete rubric or timed acceptance pass.

The earlier installed executable's CDP run `lw-e2e-f53bb68f` passed T-A1/T-A2/T-C1
(Automatic persistence, actual Stop/resume, context UI). Later deployments removed
the website-specific guide. Deployment verifies copied hashes and keeps backups;
it now includes the explicitly patched agent and its manifest, preserving models,
OfficeCLI and user data.

Browser visibility follow-up: headless is now mandatory in `_launch_options`,
using the existing bundled headless shell. Windows lifecycle checks assert no
new browser or console window throughout the session. An unrelated TodoMVC smoke
test (`browser-general-7irtt5za`) verified fill, Enter, checkbox, filter navigation,
state inspection and screenshot without site-specific code. This verifies browser
tools, not the model's reasoning across arbitrary websites. The last full model
run compacted twice (210s and 215s for the summary requests); Strata's selected
config has `--max-context 32768`, INT8 KV. No inference setting was changed.

Timing audit of that guided run: 62 completed inference requests, 32,445 generated
tokens, 75 tool calls; summary requests generated 4,518 and 5,552 tokens and took
210s and 215s. The pinned aionrs compactor uses a detailed nine-section coding
summary prompt and a 20k output allowance (`compact/prompt.rs`, v0.2.11); it does
not use the app's normal system prompt. LocalWORK now patches that separate
compactor; the user withdrew the separate smaller compaction-model idea.

## General agent efficiency

- `patches/aionrs-localwork.patch` applies to pinned upstream commit
  `8e61a90329fa9f67c4fdf7e97fe02c24dba33f75` (v0.2.11). Build with
  `scripts/build-agent.ps1`; source builds remain outside Git under `.agent-build`.
  Manifest records source, patch hash and binary hash. Never replace the agent
  with an unpatched upstream build while keeping the patched manifest.
- Automatic and manual compaction use the same task-neutral checkpoint prompt,
  aiming at 800–1200 tokens with a 3072 output allowance. It prioritizes user
  constraints, verified evidence/source links, artifact paths and pending work,
  omitting the old coding recap and extra analysis block. A provider MaxTokens
  finish rejects the summary before replacing history; original history remains.
  A concise prompt/cap is not itself proof of speed or retention quality.
- `officecli ["verify","file.docx"]` is an app-side bundle: validate, issues,
  outline, text, ordinary Word stats (four checks for XLSX/PPTX). Each result
  remains labelled, errors and clipping explicit. It reduces five model tool
  round trips to one; it does not skip the CLI checks or judge user requirements.
  `--page-count` is opt-in for DOCX and bounded to 20s: Word repagination hangs
  on this machine. Default DOCX live smoke completed in 1.83s. Page limits remain
  unverified if repagination fails; ordinary stats cannot establish page count.
- Browser CLI `### Error` output is a real MCP failure even when its process
  exits zero. Full diagnostic is recoverable at `.browser/last-error.txt`;
  repeated failed evaluations recommend changing approach. Snapshot slimming
  retains unnamed clickable generic refs for arbitrary custom controls.
- Focused verification: compactor 102 tests; targeted agent Clippy and fmt;
  bundled-agent JSONL check `agent-context-jklq9x6d` observed five automatic and
  one manual compaction using the patched prompt/3072 allowance, ordinary 512.
  App Rust library 18 passed/one optional ignored (loopback tests require sandbox
  access); browser output 5, Office verify 7, workspace MCP 1 test/six cases passed.
  Windows headless lifecycle passed. Real OfficeCLI checks passed for all formats;
  optional Word page-count timeout was reported incomplete as intended.
- Deployment `20261017-093349-a3cfd869` verified 23 copied files, including the
  patched agent. Installed-build CDP run `lw-e2e-52c3be29` passed T-A1/T-A2/T-C1
  with isolated data and deterministic inference. Release instructions were
  checked in the built executable before the final copy. No commit/push occurred.
- A real Strata prompt comparison in `efficiency-compaction-20261017-092818`
  stalled without usable streamed output and was aborted; its owned server was
  stopped. Concurrent release compilation also confounded latency. No measured
  compaction speedup or full-workflow tool-count improvement is established.
  Fixture, exact old/new prompts, startup log and failure status are preserved.

Hardware/context trial (`../.e2e-runs/context64-myd3lgza`): RTX 4060 Ti 16 GB,
32 GB RAM, Ryzen 5 7600. Compared unchanged 32K/INT8 against an isolated
64K/INT8 config with `--kv-resident 32768`. Same 2,001-token short prompt, two
requests each: API decode rates 35.4/42.1 TPS versus 33.0/43.5 TPS. The 64K
config correctly answered a 39,274-token prompt in 105.9s (API decode 31.1 TPS).
This is a smoke test, not a full-window quality or multitasking benchmark.
Both peaked near 15,601 MiB total GPU use; during the 64K long prefill, available
RAM briefly fell to about 0.01 GiB (14/69 samples below 0.25 GiB), recovering
to about 3.75 GiB after processing. The normal selected config remains at 32K;
do not declare 64K a comfortable daily default from this test alone.

## Entry points

- `src/App.tsx`: chat/approvals, model state, conversation persistence and Files &
  visuals panel. Newly completed `show_document` calls open the panel; reopening a
  chat does not replay old UI actions.
- `src/Workspace.tsx`: file picker, Office/text previews, revision selection,
  open/reveal, save-copy, and user-reviewed revision requests. Requests go into the
  existing composer, never directly to the agent.
- `src-tauri/src/documents.rs`: registered Tauri commands for list, preview,
  revisions, open/reveal and export. Reuses OfficeCLI HTML exports, with no new
  server, rendering engine or production dependency.
- `workbench-mcp/server.py`: `show_document` validates an existing workspace file;
  `assemble_document` exposes Open Intelligent UI HTML fragments. `src/Rich.tsx`
  displays persisted tool arguments. Showing a file does not validate its quality.

## Open Intelligent UI

`src/vendor/open-intelligent-ui/README.md` records the pinned MIT upstream commit
and adopted files. Theme/SVG/form styles, the assembler and response playbook are
adapted to the existing local agent and MCP. This is an offline subset; the full
Next.js/FastAPI app, cloud router, CDNs and streaming Websandbox are excluded.

`src/intelligent-ui.ts` builds iframe documents. `src/SandboxedUi.tsx` uses an
opaque-origin sandbox and validates message source and payload. Follow-ups require
review and a normal send action. Child CSP blocks remote resources; parent
`frame-src` in tauri.conf.json also blocks frame self-navigation. Tauri CSP
rewriting is disabled only for script/style directives, preventing app nonces
inherited by srcdoc from breaking widget/Office inline scripts. Keep these paired
policies and the sandbox regression test together. Saved visuals retain MIT notice.

## Documents and history

- Resolve existing files canonically inside the chat's folder; reject ADS paths.
  Listing skips symlinks/reparse points and hidden/vendor/node_modules/target
  directories. Depth limit 4; at most 300 sorted entries.
- Previews: 8 MB limit; hidden OfficeCLI with updates disabled, bounded/drained
  stdout/stderr and 45-second deadline. DOCX/XLSX/PPTX use `view <file> html`.
  No screenshot/PDF export or Office installation required. HTML is approximate;
  remote fonts/libraries are blocked. PDFs open externally. Markdown previews
  neither load images nor navigate links.
  Normalize the verified canonical path back to native DOS/UNC spelling only at
  the OfficeCLI/Explorer boundary. Passing the `\\?\` prefix to OfficeCLI can miss
  its resident document session and cause a false file-lock error.
- `agent.rs` copies supported existing workspace files before approved direct edits
  and OfficeCLI mutations. Immutable bytes and source-bound metadata live under
  app data `document-revisions/<stable-canonical-path-key>/`. Deduplicated; 32 MB
  file limit; snapshot failures deny the edit with a reason. Arbitrary shell writes
  and changes through external applications are outside this guarantee.
- Explicitly approved external edits retain existing policy behavior but do not
  enter workspace history. Old revisions can be previewed and saved as new files.
  Exports never overwrite. No automatic pruning or destructive restore operation.

## Checks and build (repo root)

```powershell
npm run build
npm run test:workspace
& '..\strata\.venv\Scripts\python.exe' scripts/tests/test_workspace_tools.py
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib documents::tests
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib revision_tests
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib documents::tests::officecli_html_previews -- --ignored
npx tauri build --no-bundle
```

Node tests use the pinned headless browser on in-memory synthetic content. Office
integration checks create temporary synthetic Word/Excel/PowerPoint fixtures. No
live app/model needed. Office checks are opt-in because binaries are not committed.
See HANDOFF.md for deployment layout; plain cargo release builds are unsuitable.
Repo-wide rustfmt has pre-existing drift (including untouched voice.rs); avoid
mixing wholesale formatting changes into features.

## Automated desktop acceptance checks

`scripts/e2e/run-all.ps1` uses WebView2 CDP on loopback port 9333; it does not need
mouse/keyboard automation. By default it runs against a lightweight Strata stand-in
with separate app data and no real inference. It refuses to run if LocalWORK is
already open, protecting existing sessions. `-Only T-W1` runs the complete new
workspace group through `workspace-cdp.mjs`: real Office previews, previous-version
selection/recovery, no-overwrite exports, visual controls/contrast, reviewed
follow-ups and revision drafting. `workspace-fixtures.py` seeds only synthetic test
files and conversations. Capture itself is tested separately at the native hooks.

```powershell
pwsh -NoProfile -File scripts/e2e/run-all.ps1 -Exe src-tauri/target/release/localwork.exe -Iterations 2 -Only T-L1,T-L2,T-L3,T-L4,T-L5,T-L6,T-S3,T-S5,T-S6 -WorkRoot ../.e2e-runs -KeepWork
pwsh -NoProfile -File scripts/e2e/run-all.ps1 -Exe src-tauri/target/release/localwork.exe -Only T-W1 -WorkRoot ../.e2e-runs -KeepWork
```

Reports/screenshots are preserved under the chosen run root with `-KeepWork`.
Otherwise the runner verifies the resolved directory before deleting its own run.
The debug port and test credentials are test-only; do not enable remote debugging
in the normal launcher. Tests of the stand-in do not establish live-model quality.

## Desktop chat and window behavior

- New chats start with a composer. First send/paste/attachment creates a distinct
  `<Documents>/LocalWORK/<chat-id>` folder using the OS Documents location. A saved
  `projects_folder` overrides the parent. The folder button starts a new chat in
  an existing folder; it does not retarget an existing chat's agent/session.
  Deleting a chat does not delete its output files. Navigation generations prevent
  pending creation/attachments from activating or populating a different chat.
- Native decorations are disabled. Window controls and a draggable header are
  integrated into the content; explicit window permissions remain in capabilities.
- `desktop.rs` validates HTTP(S) URLs and opens them through Windows ShellExecuteW
  (system default browser). A delegated anchor handler and native navigation guard
  prevent ordinary external links from replacing the app. Local Tauri/dev URLs
  remain internal. Markdown file previews deliberately still disable their links.
- Composer TPS defaults on; `show_tps=0` hides it persistently. `model_telemetry`
  polls status asynchronously without sysinfo refresh, returns current or last
  generation rate, and keeps credentials in Rust. Missing telemetry shows a dash.
- `browser.py` adds a small atomic Node preload to Playwright subprocesses on
  Windows so both daemon and browser receive `windowsHide: true`.
  The Python launcher also retains CREATE_NO_WINDOW. No vendor patch or new deps.
- `python scripts/tests/browser_windows.py` exercises open/snapshot/close against
  about:blank with an isolated profile and monitors newly visible console windows.
  Requires normal Windows subprocess permissions. `-Only T-W1` now includes desktop
  checks T-D1..T-D6 for links, TPS persistence, automatic folders, optional folder,
  window decorations, delayed creation/attachment navigation races, and model
  start/stop in Settings (T-D6). Link
  dispatch and model-send boundaries are intercepted; no live inference is asserted.

## Outstanding risks

Policy normalizes parent path components and uses protected-directory boundaries;
arbitrary shell scripts and browser eval remain outside a strict sandbox. Live
model reasoning and artifact quality remain separate from deterministic checks.
Loopback HTTP tests require normal network permissions; the full Rust library
suite passes outside the restricted sandbox. No in-app Office WYSIWYG editor.
