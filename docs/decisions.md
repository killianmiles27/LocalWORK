# Decisions
- Tauri 2 host, aionrs `--json-stream` per conversation, Strata as sole inference server (spec option D).
- Job Object by self-assignment of the host (KILL_ON_JOB_CLOSE) instead of per-child process-wrap: simpler, still kills the whole tree if the host dies. `pids.json` cleans up stale trees at next start.
- Per MODEL-HANDOFF.md: launch `server.py` with `selected-model.json`, explicit host/port (free port), no `--open`, key in memory only, ownership checked with protected `/v1/models`.
- Approval policy is in the Rust host; aionrs always receives `tool_approve` scope `once`.
- Workbench MCP runs on Strata's Python. Its server is stdlib-only; web libraries (ddgs, httpx, beautifulsoup4, markdownify, pypdf) live in `workbench-mcp/libs` (installed with scripts/install-mcp-libs.ps1) so the model environment is never modified. markitdown was dropped: it pulls onnxruntime/magika (large) for no gain over markdownify.
- Stage 0 experiments and benchmarking skipped by request.
- Voice input: browser records 16 kHz mono WAV, host runs whisper.cpp `whisper-cli` (CPU, small q5_1 multilingual model, auto language) per clip inside the Job Object; GPU stays free for Strata. "Tidy up" posts to Strata's /v1/chat/completions with thinking off.
