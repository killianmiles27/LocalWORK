# LocalWORK project context

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
  Windows so both daemon and headless Chromium receive `windowsHide: true`.
  The Python launcher also retains CREATE_NO_WINDOW. No vendor patch or new deps.
- `python scripts/tests/browser_windows.py` exercises open/snapshot/close against
  about:blank with an isolated profile and monitors newly visible console windows.
  Requires normal Windows subprocess permissions. `-Only T-W1` now includes desktop
  checks T-D1..T-D6 for links, TPS persistence, automatic folders, optional folder,
  window decorations, delayed creation/attachment navigation races, and model
  start/stop in Settings (T-D6). Link
  dispatch and model-send boundaries are intercepted; no live inference is asserted.

## Outstanding risks

Legacy policy issues identified earlier remain: lexical workspace path checks and
malformed consequential-browser-action regex. The existing HTTP chunked-response
test failed in the restricted environment before this change; do not describe the
whole test suite as passing. Live-model reliability and installed-app acceptance
testing with the real model is separate from these deterministic acceptance checks.
No in-app Office WYSIWYG editor.
