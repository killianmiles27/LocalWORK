# Developer backend: Codex subscription instead of Strata

This is a development tool, not a product feature. It lets you click through the app and exercise the
agent loop without loading a model, using the ChatGPT Codex subscription that is already signed in on
this PC. Normal builds never offer it.

**Prompts, file contents and tool output leave this PC while it is connected.** Do not use it with
private work, and do not treat a pass here as a local-model test. Use Strata for that.

## What it is

- `scripts/dev/codex_bridge.py` serves an OpenAI-compatible `/v1/chat/completions` endpoint on
  loopback. It translates chat messages and tool calls to the Codex Responses API and streams the
  answer back, including tool-call deltas.
- `src-tauri/src/dev.rs` starts that script, writes the normal "server you run" settings
  (`modelSource`, `serverPort`, `serverKey`, `serverContext`) plus a `devBridge` record, and restarts
  the model connection. The agent and the rest of the app are unchanged.
- Settings → Model shows a **Developer backend** card when the build is a debug build, when
  `LOCALWORK_DEV_CODEX` is set, or when a `devBridge` record already exists.

The bridge reads `%USERPROFILE%\.codex\auth.json` (or `~/.codex/auth.json`). It never writes it, never
refreshes the token, and never logs the token or prompt text. If the token has expired, open Codex or
run `codex login` once.

## Use it

Prerequisites: Python 3.11 or newer (the same interpreter the Workbench tools use), the Codex CLI
signed in, and the repository's normal dev setup (`npm ci`, vendor tools, agent build).

1. Start the app: `npm run tauri -- dev`.
2. Open **Settings → Model → Developer backend**.
3. Pick a model (`gpt-6-luna`) and effort (`low`), then **Connect**. The model indicator switches to
   the bridge and chats use it until you press **Disconnect**.

You can also run the bridge yourself and use the existing external-server flow:

```powershell
npm run dev:bridge
# then Wizard → "I run my own model server" → port 18080
```

The standalone form is useful for a release build, where the Developer card is hidden unless you set
`LOCALWORK_DEV_CODEX=1` or point `LOCALWORK_CODEX_BRIDGE` at the script. `npm run dev:bridge` starts
without an API key so it is easy to try; it prints a warning, accepts only loopback `Host` headers,
and should be stopped when you are done. The in-app card always generates a per-launch key.

To keep experiments away from your real chats, launch the app with an isolated data folder:

```powershell
$env:LOCALAPPDATA = Join-Path $env:TEMP "localwork-dev"
npm run tauri -- dev
```

## Limits

- **Offline mode is refused, and it disconnects the bridge.** Connect fails while offline mode is
  on. Turning offline mode on later stops the bridge and the running model, and restores the Strata
  setting, so no prompt keeps going to OpenAI behind an "offline" label.
- **Not a local-model test.** Tool calling and streaming are translated by the bridge, so a bug you
  see may be in the translation rather than the app. Compaction uses the generic checkpoint path
  (the bridge deliberately does not advertise Strata's native compaction capability).
- **Switching modes disconnects.** Saving a Strata model profile or choosing a mode sets
  `modelSource` back to `strata`. Reconnect from the Developer card afterwards. **Disconnect**
  restores the port, key, context and source that were in use before you connected.
- **Auto-start is a debug-build convenience.** A debug build restarts a saved bridge when the app
  opens. A release build does not, even if a saved record exists; it only starts one when you press
  Connect, or when `LOCALWORK_DEV_CODEX` is set. A released binary with no such opt-in never sends
  anything by itself.
- **Connecting is refused while a reply is running.** Stop the turn first; both Connect and
  Disconnect shut down running agents.
- **The bridge presents the Codex CLI's request identity** (`originator: codex_cli_rs`, its user
  agent) because that is what the subscription endpoint accepts. It is a loopback shim for your own
  account, not an impersonation feature for distribution; check the account terms before relying on
  it.
- **Context is reported as 131072 tokens** so the context ring and compaction behave plausibly. It is
  a fixed number, not the model's real limit.
- **Telemetry is approximate.** The bridge reports tokens per second from the last stream.
- **Codex terms apply.** This reuses your own signed-in subscription through a local loopback shim.
  Check that this is acceptable for your account; do not distribute the bridge as a hosted service.

## Tests

`python -m unittest scripts.tests.test_codex_bridge` covers the request translation without network
or credentials. The rest of the app's checks are unchanged; see [CONTRIBUTING.md](../CONTRIBUTING.md).
