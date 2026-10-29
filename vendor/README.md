Binaries here are not committed (see .gitignore). Fetch tools with scripts/fetch-vendor.ps1; build the pinned, patched agent with scripts/build-agent.ps1. Versions, source revision and hashes are in manifest.json. The tracked patches/aionrs-localwork.patch replaces the coding recap with a concise general-purpose checkpoint, bounds summary output at 3072 tokens, and rejects truncated summaries before replacing history. Builds retain their source checkout; the build script never resets existing edits. Binary hashes can vary by compiler/toolchain; the build records the resulting hash for deployment verification.

The agent patch also pins security updates for its HTTP/QUIC/TLS dependencies in
the upstream Cargo.lock. Rebuilding unpatched v0.2.11 restores known vulnerable
versions. Keep the exact patched source checkout for the release notice inventory.
It also preserves MCP tool error flags and checkpoints completed work inside a long
first user turn when native compaction cannot split older turns. Candidate histories
are checked through the native service before being saved.
The patch also closes shell-child stdin, keeps tools available during bounded
generation recovery, and checks unfinished plans before accepting a final reply.
See docs/SETUP.md and docs/release.md for build and redistribution steps. Existing
Whisper/browser files are checked for availability/version when reused; that is
not a full tamper-detection check of every installed executable or npm file.

`vendor\whisper` holds whisper.cpp's `whisper-cli.exe` (CPU build) and `ggml-small-q5_1.bin` (about 190 MB) for push-to-talk. The same script fetches both.

The browser tool needs vendor\node (portable Node), vendor\playwright (@playwright/cli) and vendor\browsers (Chromium headless shell); fetch-vendor.ps1 installs all three.

Optional local attachment OCR looks for `vendor/tesseract/tesseract` and `vendor/pdftoppm/pdftoppm` on Linux, or `vendor\tesseract\tesseract.exe` and `vendor\pdftoppm\pdftoppm.exe` on Windows. Place each program's required libraries and Tesseract language data where that installation expects them; these tools are not fetched or bundled by the current scripts. Explicit `LOCALWORK_TESSERACT` / `LOCALWORK_PDFTOPPM` paths take precedence, then this layout, then PATH. Packaging and redistribution of these optional binaries and their licenses must be handled separately.

The agent patch also supports explicit execution-stage effort hints and per-request timing/token diagnostics. Provider timing metadata is separate from message content and never enters model history. The build script checks provider parsing and agent execution/recovery regressions before building.
