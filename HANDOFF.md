# LocalWORK handoff

Updated 2026-10-16. Read this first, then the relevant sections of
[docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md). This is project context, not a
request to start implementing additional features. The current user's task sets scope.

## Current baseline and locations

- Shipped implementation: `43cde3b` on `main`, pushed to
  https://github.com/killianmiles27/LocalWORK.
- Source repository: `C:\Random\Working Folder\LocalWORK\app`.
  The surrounding folder also holds Strata and local test/deployment artifacts;
  those are outside Git. Do not mistake the parent folder for the repo root.
- Installed app: `C:\Random\LocalWORK\LocalWORK.exe`.
  Edit source in the repo, then build and deploy. Do not maintain separate product
  changes in the installation directory.
- The installed executable matched the tested release build by SHA256. The last
  deployment verified 21 copied files and preserved a backup under
  `C:\Random\Working Folder\LocalWORK\.deployment-backups\20261016-112657-25e4729e`.
- User data: `%LOCALAPPDATA%\Workbench` (SQLite conversations/settings, logs,
  revisions and rollback data). Preserve it during normal development/deployment.
- No new GitHub release/installer was published for this work; `main` and the
  user's existing local installation were updated.

## Branding (2026-10-16)

Calm, flat, no gradients. Manrope, compact 13px scale in `src/index.css` `@theme`. Indigo accent (kept on purpose, user
likes it; teal was tried and rejected): light `#3a47c4` on `#f4f1ea`, dark `#9fb0ff` on `#171717`. Extra tokens
added beside it: ember `#d9663a`/`#ff9a6b` (selection, caret, link hover), sage and gold for status. `src/Mountain.tsx` paints the dithered-glyph
mountain (`src/assets/mountain.jpg`, castle anchored left) once per resize/theme change onto one canvas:
integer-hash noise and per-cell jitter avoid banding, no animation loop, no click/cursor effects.
Message text sits on `.frost` (3px blur, 14% tint, feathered mask); the sidebar and composer use similar
light backing. The chats sidebar collapses instantly and remembers its state;
no rail, no Chat/Work switch. Cross-chat memory injection is disabled in `agent.rs` on purpose.
Rebrand brief for Claude Design: `docs/BRAND_BRIEF.md`.

## Product intent and user preferences

The goal is a friendly, local alternative to Claude Cowork / ChatGPT Work:
one launch, local model startup, natural multi-step requests, attachments, web
research, memory, documents, spreadsheets, slides and interactive visuals.
Feature presence does not establish equivalent reliability or output quality.

Prefer maintained existing GitHub projects and small adaptations over rebuilding
existing engines or importing entire stacks. Avoid dependency bloat, technical
labels in everyday UI, and mandatory folder selection. The user provided ChatGPT
Work screenshots as layout inspiration. Model identity belongs in the sidebar;
generation speed belongs beside the composer. Keep optional controls discoverable.

## Architecture and existing capabilities

Tauri 2 / Rust host with WebView2, React 19, Vite and Tailwind 4. This is not
Electron. Strata is the separate local inference engine. A vendored aionrs process
runs each conversation's agent loop; the local Python workbench MCP supplies tools.
The Rust host owns approvals. Keep inference credentials in Rust, never frontend,
logs or committed files. See `docs/MODEL-HANDOFF.md` for the engine contract.

Already present: streaming chats, thinking/tool output, approvals, conversation
history, persistent memory, attachment button/paste/drop, PDF/Office/text extraction,
push-to-talk transcription and request tidying, web search/fetch, Playwright browser,
OfficeCLI creation/editing, charts/tables/diagrams, plan checklist, SSH administration
with host-key trust and policy, first-run setup, model engine update controls,
single-instance handling, process cleanup, signed updater and version rollback.
Do not re-add these based only on an old feature checklist.

## What this work added or changed

### Document workspace and interactive UI

- A Files side panel beside chat: Word/Excel/PowerPoint HTML previews, Markdown/text
  previews, file/visual selection, open externally, reveal, save copy, previous
  versions, expanded preview, and Ask for changes. Revision requests fill the
  composer for review; they do not auto-send. PDFs currently open externally.
- `show_document` MCP tool presents an existing workspace file. Newly completed
  results can open the panel; reopening a historical chat does not replay them.
- `assemble_document` adapts a pinned MIT subset of CopilotKit/OpenIntelligentUI:
  theme, SVG/form styles, assembler pattern and response playbook. Source and
  license details are in `src/vendor/open-intelligent-ui/README.md` and NOTICE.md.
  The full Next.js/FastAPI stack, cloud router, CDNs and Websandbox streaming
  runtime are not included. No new production dependencies were added.
- Interactive content uses opaque-origin sandboxed iframes, restrictive CSP,
  validated bounded messages, blocked remote resources/navigation and explicit
  follow-up review. Keep the parent/child CSP and sandbox tests together.
- Supported direct edits and OfficeCLI mutations capture immutable, deduplicated
  previous versions under app data before editing. Snapshots are source-bound;
  exports refuse overwrites. Arbitrary shell writes and external-app changes are
  outside this capture guarantee. There is no automatic destructive restore.
- OfficeCLI receives normal DOS/UNC paths only after canonical containment checks.
  Passing Windows `\\?\` paths directly caused false resident-session/file-lock errors.

### Desktop and chat experience

- New chat opens a usable composer. First send, attachment or paste creates a
  separate `<OS Documents>\LocalWORK\<chat-id>` output folder. A configured
  `projects_folder` overrides the parent. The OS Documents API handles relocation.
- The composer folder button starts a new chat in an existing folder; it does not
  retarget a conversation's existing agent/session. The folder-name button reveals
  its location. Deleting a chat does not delete its output files.
- Navigation generation guards stop delayed creation/attachment results from
  switching back to an old chat or populating the wrong draft.
- Native decorations were removed. Minimize/maximize/close and dragging are
  integrated into the content header, with explicit Tauri window permissions.
- Normal external HTTP(S) links use Windows ShellExecuteW, opening the system's
  default browser. A frontend anchor handler and native navigation guard prevent
  external web pages from replacing the app. Local Tauri/dev navigation stays local.
  Markdown file previews still intentionally suppress their own links/images.
- Sidebar shows the model and state, with fewer labels and no repeated folder paths.
  Model start/stop controls remain available in Settings.
- Composer TPS defaults on and persists via `show_tps` (`0` hides it). Lightweight
  asynchronous telemetry uses model status endpoints without the heavier sysinfo
  refresh. It shows current/last speed or a dash when unavailable.
- Browser console flash fixed in `workbench-mcp/browser.py`: CREATE_NO_WINDOW on
  Python's child plus an atomic Node preload setting `windowsHide: true` for
  Playwright's daemon/browser spawns. No ignored vendor patch is required.

### Context management and chat polish
- `agent::write_compact_config` writes a managed `<workspace>/.aionrs.toml` (marker `# managed by LocalWORK`; never overwrites a file without it) so aionrs uses the real Strata window (`strata::context_window()`, from `--max-context`) and autocompacts at about 80%. aionrs otherwise assumes 200k.
- Composer ring (`ContextRing` in `App.tsx`) shows usage from kv `ctx:<conv>`, refreshed by sending `/context` after each turn; click or type `/compact` to compact (`agent_compact`). Commands: `agent_compact`, `context_usage`.
- Compaction `info` events store a centered `notice` message.
- Plain tool calls collapse into a muted "Used N tools" group (`ToolGroup`); rich tools and memory chips stay separate.
- `agent::maybe_title` names a conversation once (kv `titled:<conv>`) with a tiny local-model call. `delete_conv` clears both kv keys.
- Verified with a fake OpenAI server (no compaction at 5.5k tokens, compaction near 27k). Ring, grouping and titles were only compile-checked, not clicked through.

## Important files

| Files | Responsibility |
| --- | --- |
| `src/App.tsx`, `src/Settings.tsx`, `src/Wizard.tsx` | Chat lifecycle, composer, links, window controls, TPS and setup |
| `src/Workspace.tsx`, `src/Rich.tsx` | File/visual panel and in-chat tool rendering |
| `src/SandboxedUi.tsx`, `src/intelligent-ui.ts` | Sandboxed documents, bridge, offline HTML assembly |
| `src-tauri/src/lib.rs`, `desktop.rs`, `strata.rs` | Commands, automatic folders, OS browser/folder opening, navigation and telemetry |
| `src-tauri/src/documents.rs`, `agent.rs` | Containment, previews, exports, revisions and pre-edit capture |
| `src-tauri/src/policy.rs`, `sshpolicy.rs`, `ssh.rs` | Approval/SSH trust boundaries |
| `src-tauri/src/supervisor.rs`, `rollback.rs`, `store.rs` | Process lifecycle, recovery and persisted state |
| `src-tauri/tauri.conf.json`, `capabilities/default.json` | Embedded assets, CSP and window permissions |
| `workbench-mcp/server.py`, `browser.py`, `skills/intelligent-ui/` | Tools, quiet browser launcher and reused UI guidance |
| `scripts/e2e/`, `scripts/tests/` | Isolated CDP acceptance checks and focused regressions |
| `scripts/deploy-local.ps1` | Backup, deploy and hash-check the existing installation |

## Build, verify and deploy

Commands below run from the repository root, not its parent. Existing vendor files
and Strata's Python environment are required for browser/Office checks. Provisioning
is documented in `scripts/fetch-vendor.ps1` and `scripts/install-mcp-libs.ps1`.
Do not reinstall or download dependencies merely to inspect the project.

```powershell
npm run build
npm run test:workspace
& '..\strata\.venv\Scripts\python.exe' scripts/tests/test_workspace_tools.py
python scripts/tests/browser_windows.py
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib desktop::tests
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib telemetry_tests
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib documents::tests
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib revision_tests
npx tauri build --no-bundle
pwsh -NoProfile -File scripts/e2e/run-all.ps1 -Exe src-tauri/target/release/localwork.exe -Only T-W1 -WorkRoot ../.e2e-runs -KeepWork
pwsh -NoProfile -File scripts/deploy-local.ps1
```

Build through Tauri, not plain `cargo build --release`: plain Cargo can produce an
executable pointing at the development server and display a blank window. The
release executable is `src-tauri\target\release\localwork.exe`.

Deployment refuses while LocalWORK is running, backs up all replaced files first,
copies the exe/MCP Python/skills/notices/handoff, then checks every hash. It leaves
vendor binaries, models, user data and Git alone. No rebuild is needed for a
handoff-only edit. Commit/push/release only within the current user's authorization.

## Verification actually performed

- Frontend production build and Tauri release build passed.
- Three Node workspace/sandbox tests passed; Python MCP test passed six tool cases.
- Nine focused Rust tests passed across desktop, telemetry, documents and revision
  hooks. The opt-in OfficeCLI integration test also passed for DOCX/XLSX/PPTX.
- Final CDP group: **11/11 passed**, covering Office/text/revision previews,
  recovery/no-overwrite behavior, interactive controls/follow-up review, external
  link dispatch, TPS persistence, automatic/optional folders, window controls,
  delayed attachment/navigation races and model start/stop in Settings.
- Lifecycle T-L1/T-L2/T-L3 passed on a preceding build: clean close, forced host
  termination, engine failure/restart and conversation preservation. Earlier in
  this work T-L1..T-L6 and T-S3/T-S5/T-S6 also passed with the stand-in.
- Quiet-browser regression used real vendored Playwright/Chromium with isolated
  profiles: open about:blank, snapshot, close; both spawns had windowsHide enabled,
  and no new visible console window appeared. No browser process remained.
- Deployment hashes matched; Git was clean and `origin/main` matched `43cde3b`
  after the implementation push, before this handoff-only update.

The CDP harness uses loopback port 9333, isolated app data and synthetic fixtures;
it refuses to start if LocalWORK is already open. It needs no native PC control.
`-Only T-W1` includes T-W1..T-W5 and T-D1..T-D6. Link dispatch/model-send boundaries
are intercepted where appropriate; real Office binaries/rendering and native folder
commands are exercised. Default inference is a lightweight Strata stand-in.
Do not present these results as live-model output-quality evaluation. Test reports
and screenshots are preserved under `../.e2e-runs/` with `-KeepWork`; the last full
workspace/desktop report is `lw-e2e-7de42f61/results.json`. Never enable the debug
port in the normal launcher.

## Remaining limitations and follow-up context

- Office previews are approximate HTML; no in-app WYSIWYG Office editor or
  pixel-perfect rendering. PDFs do not yet have an embedded preview.
- Local-model multi-step reliability, final artifact quality and long-running
  real-model acceptance/soak coverage remain separate from deterministic UI tests.
- Prior review flagged lexical workspace checks and a malformed consequential
  browser-action regex in legacy policy code. These were not repaired here;
  inspect `policy.rs` before extending those trust boundaries.
- The HTTP chunked-response unit test previously failed in the restricted
  environment. Repository-wide rustfmt has pre-existing drift, including untouched
  voice code. Do not claim the entire suite passes or bulk-format unrelated files.
- Full live SSH administration, actual version-to-version rollback, live Strata
  update application, installer acceptance for these changes, and an 8-hour soak
  were not performed in this work. Older handoff claims are historical evidence,
  not a current full acceptance pass.
- Citation registry, dedicated `search_files` tool, broader Activity UI and
  Authenticode signing remain outstanding. Existing diagrams/charts are basic.

Keep changes scoped to the next request. Preserve pre-existing edits and consult
relevant source before trusting documentation. No model identifiers in committed
project artifacts; runtime model display is intentional. Never commit vendor/libs
binaries or private keys. Use the configured repository author and a Co-Authored-By
trailer for authorized commits. See `docs/release.md` for signing/release procedures.
