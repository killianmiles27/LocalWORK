Binaries here are not committed (see .gitignore). Fetch tools with scripts/fetch-vendor.ps1; build the pinned, patched agent with scripts/build-agent.ps1. Versions, source revision and hashes are in manifest.json. The tracked patches/aionrs-localwork.patch replaces the coding recap with a concise general-purpose checkpoint, bounds summary output at 3072 tokens, and rejects truncated summaries before replacing history. Builds retain their source checkout; the build script never resets existing edits. Binary hashes can vary by compiler/toolchain; the build records the resulting hash for deployment verification.

`vendor\whisper` holds whisper.cpp's `whisper-cli.exe` (CPU build) and `ggml-small-q5_1.bin` (about 190 MB) for push-to-talk. The same script fetches both.

The browser tool needs vendor\node (portable Node), vendor\playwright (@playwright/cli) and vendor\browsers (Chromium headless shell); fetch-vendor.ps1 installs all three.
