# Security

LocalWORK is early software that can run commands and change files with the current Windows user's permissions. It has approval checks, not an OS sandbox. Use a dedicated working folder and backups. Use a separate account or VM for untrusted documents, repositories, and websites, especially on a sensitive network.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/killianmiles27/LocalWORK/security/advisories/new) if it is enabled. If that form is unavailable, open an issue asking for a private reporting channel **without posting the exploit, credentials, private files, or personal logs**. No monitored security email or response-time guarantee is advertised.

Include the affected commit/version, Windows version, minimal reproduction, expected behavior, and impact. Redact secrets. The maintained source branch is `main`; this is not a promise to maintain every older build.

## Boundaries

- Automatic mode is enabled by default. Command and action classification reduces prompts; it does not prove a script is safe. Turning it off also does not create OS isolation. Automatic mode still asks before commands that publish, push or upload, connect to another computer, run as administrator, or change files and settings that run code automatically; the classifier looks inside common `cmd`, PowerShell and `sh` wrappers. It also asks before reading or writing a file outside the chat's working folder (an approval covers that outside folder only) and before fetching a web address whose query string or long path segment looks like encoded data. Known credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, OS keyrings, browser profiles and `.env` files outside the folder) are refused in every mode, for file tools and for paths named in shell commands; symlinks are resolved before that comparison. A command it cannot recognise may still run without asking, and code the model runs can read files itself.
- OfficeCLI paths are checked by the host. Generic scripts, model tool implementations, file links, and subprocesses remain capable of using the user's other permissions. Revision history does not cover every shell operation.
- Web fetching validates public destinations at every redirect, pins the checked IP for the connection, preserves TLS hostname verification, bypasses environment proxies, and limits downloads. This is not a firewall for other tools.
- Browser navigation checks and hostname filters do **not** fully constrain page subrequests or DNS rebinding. A hostile page may reach services accessible from the PC. Do not treat the browser as private-network isolation.
- A local server API key is generated for each model launch and passed through environment variables. Local processes running as the same user can still inspect or affect app processes. Do not expose the model or test CDP listener to the network.
- Model configuration is trusted executable configuration. Only choose a Strata installation and configuration you trust.
- Engine setup downloads and runs trusted upstream PolyStrata scripts, which may install packages and fetch models. The application's downloader host allowlist does not constrain networking performed by those scripts. Hugging Face file downloads pin a repository revision and validate relative paths; hardware-fit estimates do not establish compatibility or model safety.
- SSH uses host-key verification and explicit host configuration. Its read-only classifier is conservative, but it is not a remote sandbox. Use a restricted account.
- Interactive document previews use an opaque iframe sandbox. Opening a file externally delegates to the installed application and its security model.

## Privacy

Inference runs locally. Searches, browsing, downloads, update checks, and SSH contact external systems. The web toggle is a tool setting, not network isolation. There is no claim that the app can never transmit data.

Conversation databases, cached pages, saved attachments, logs, and browser cookies can contain private information. They are not encrypted by LocalWORK. Review diagnostic material before sharing it. Do not commit data folders, credentials, signing keys, or `.env` files.

## Distribution

App updates require the configured updater signing key. This is separate from Windows Authenticode signing. The supported updater artifact is a signed Windows installer EXE; ZIP update extraction is disabled. Forks must configure their own update endpoint and signing key before distributing builds.

See [the audit record](docs/PUBLIC_READINESS.md) for checks performed and remaining release work. A scan without findings is not a guarantee of security.
