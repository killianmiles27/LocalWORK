# Strata integration contract

LocalWORK runs a separately installed Strata service. Install and test the model with upstream first; use the same generated configuration here. Model weights have separate licenses and are not redistributed by this repository.

## Configuration

Settings stores `strataRoot` and `modelConfig` in the user's app data. The wizard and Settings can select them. Without saved values, LOCALWORK_STRATA_ROOT and LOCALWORK_MODEL_CONFIG provide optional defaults; a strata folder beside the executable may also be detected. No particular drive, model, or GPU is assumed.

The selected folder must contain .venv/Scripts/python.exe and serve/server.py. The model JSON must contain an args array and valid paths for its engine, model shards, tokenizer, packs and optional runtime files. It is trusted executable configuration, not a harmless document.

## Launch

The host invokes the selected Python with server.py, --engine strata, --config, explicit loopback --host and a selected port, plus --fit-max-tokens. The server and working folder come from the config: its optional `engine_root`, else its `cwd` when that folder holds serve/server.py (a PolyStrata config keeps its own server), else the Strata folder. Python is that folder's .venv, else the Strata folder's. Settings → Model → "Add model…" copies a run config into the Strata profiles folder so it appears in the model menu; the mode list marks each entry's engine (Strata or PolyStrata). A random STRATA_API_KEY protects each launch. The agent receives that key through API_KEY in its child environment. Keys are not placed in the process command line.

/health is the readiness signal; the protected /v1/models endpoint verifies ownership before the app declares ready. One local model server is shared by chats. The host supervises its owned process tree and uses generation counters so stale pollers cannot change a replacement server's status.

The supported model API is OpenAI-compatible /v1/chat/completions with streaming tool calls. Settings reads telemetry from /status and /v1/status where available. Context allocation comes from the selected config, not a fixed UI number.

## Agent and context

The pinned agent source/patch/hash is recorded in vendor/manifest.json. Build it with scripts/build-agent.ps1. Ordinary replies use a context-dependent output cap; compaction has its own 3072-token allowance and task-neutral checkpoint prompt. The host's --fit-max-tokens launch flag prevents an output reservation from making otherwise valid input fail. Input is never silently truncated by that flag.

Compaction triggers at 80% of the configured window. Truncated checkpoint responses are rejected before history replacement. Context readings are approximate, and internal /context requests are serialized with messages because upstream does not queue concurrent requests reliably.

Native no-op responses can occur during a long first user turn. The patched agent then checkpoints completed work in at most eight summary passes, preserving genuine user requests, system history and two latest complete assistant/tool exchanges. Summary fragments are supplied as data with tools disabled; prompt-too-long retries shrink fragments without discarding source text. The candidate is revalidated and token-counted through native compaction before any session replacement. Errors, cancellation, changed protected messages or insufficient reply capacity retain the original session. Native errors do not trigger this recovery path.

Shell tasks receive `LOCALWORK_PYTHON`, the same configured interpreter used by Workbench MCP. This avoids guessing which ambient `python` installation to use. It does not install extra libraries or alter the user's PATH.

Shell command children have closed stdin so they cannot block on or consume the agent's protocol input. Output-limit recovery keeps tools available for at most two attempts. A recovery request uses disabled thinking and low reasoning effort; the saved profile and ordinary request settings are unchanged. Repeated reasoning detection is limited to unsigned native local text streams, before tool calls have been issued. If recovery cannot progress, the host displays an incomplete notice and retains completed writes.

## Testing

scripts/e2e/check-agent-context.py exercises the real agent against an isolated HTTP model fixture. scripts/e2e/run-all.ps1 uses a stub model by default; -RealStrata explicitly opts into model/GPU use. Deterministic browser probes verify tool behavior, not reasoning quality.

Earlier single-machine experiments do not establish a supported hardware minimum or broad model success rate. Choose model/context/cache settings using Strata's current documentation and measurements on the target hardware. Do not apply one developer's benchmark configuration as a universal default.

Execution stage hints are per run/request, not profile edits: only an explicit successful plan stage execution lowers native-provider reasoning effort while keeping configured thinking. Verification/analysis, tool errors and new tasks restore configured effort. Request wall/first-event timing is measured by the agent; OpenAI-compatible numeric timings (prompt/decode/cache) are retained only when the provider supplies them. These metadata events are never sent back to the model. Do not treat first streamed event wait as prefill time or promise a speedup from fixture checks.
## Model library and optional cloud routing

The model library in first-run setup and Settings delegates supported model setup and calibration to upstream PolyStrata. Downloading an engine does not bundle weights; users explicitly choose each download. Existing Strata and per-config PolyStrata paths remain supported. Calibration requires stopping the running model and is not available for every family.

The optional host router sends agent requests through an authenticated loopback proxy. Local only remains default. Automatic requires CPU privacy checking and currently uses availability, estimated context and repeated tool-error rules. It does not use Switchyard or a general task-capability classifier. Routed agents disable native Strata-only compaction. See [CLOUD.md](CLOUD.md) for trust boundaries, subscription-sign-in limitations and unverified live-service paths.
