Binaries here are not committed (see .gitignore). Rebuild with scripts/fetch-vendor.ps1; versions and hashes are in manifest.json.

`vendor\whisper` holds whisper.cpp's `whisper-cli.exe` (CPU build) and `ggml-small-q5_1.bin` (about 190 MB) for push-to-talk. The same script fetches both.

The browser tool needs vendor\node (portable Node), vendor\playwright (@playwright/cli) and vendor\browsers (Chromium headless shell); fetch-vendor.ps1 installs all three.
