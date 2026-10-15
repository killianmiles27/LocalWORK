# Building, signing and releasing the installer

## One-time: signing key
Updates are verified with a minisign key pair. The public key is embedded in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the private key never goes in the repo.

```powershell
npm run tauri -- signer generate -w "$env:USERPROFILE\.tauri\localwork.key" -p ""   # or pass a real password
```
Back the private key up somewhere safe: if it is lost, installed copies can never be updated (users must reinstall). If you generate a new pair, paste the new `.key.pub` contents (base64, one line) into `pubkey`.

For CI, store the key as the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` (file contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Build
Needs `vendor/aionrs.exe`, `vendor/officecli.exe`, `vendor/manifest.json` (see NOTICE.md / `scripts/`).

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\localwork.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run tauri -- build
```
Output in `src-tauri/target/release/bundle/nsis/`: `LocalWORK_<ver>_x64-setup.exe` and its `.sig`.

## Release (GitHub)
1. Bump `version` in `tauri.conf.json` and `Cargo.toml`.
2. Create a GitHub Release `v<ver>` and upload the setup `.exe` and `.sig`.
3. Upload `latest.json` (the app reads `releases/latest/download/latest.json`):
```json
{
  "version": "<ver>",
  "notes": "...",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of the .sig file>",
      "url": "https://github.com/killianmiles27/LocalWORK/releases/download/v<ver>/LocalWORK_<ver>_x64-setup.exe"
    }
  }
}
```
The updater runs the NSIS installer in passive mode; user data in `%LOCALAPPDATA%\Workbench` is untouched. Before 1.0 the Windows installer is unsigned (SmartScreen warning); Authenticode signing is separate from the updater key above.

## Acceptance tests
```powershell
powershell -File scripts\e2e\run-all.ps1 -Installer <setup.exe>   # installs, runs T-L1..T-L6, T-S3/S5/S6, updater check, uninstall (data kept)
powershell -File scripts\e2e\run-all.ps1 -Exe <localwork.exe> -Only T-L1,T-L2 -Iterations 3
```
Uses a stub Strata and an isolated data dir by default; `-RealStrata` uses the real one. T-S1, T-S2, T-S4 and T-L7 need a live model or UI and are reported as SKIP.
