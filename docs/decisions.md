# Decisions
- Tauri 2 host, aionrs `--json-stream` per conversation, Strata as sole inference server (spec option D).
- Job Object by self-assignment of the host (KILL_ON_JOB_CLOSE) instead of per-child process-wrap: simpler, still kills the whole tree if the host dies. `pids.json` cleans up stale trees at next start.
- Per MODEL-HANDOFF.md: launch `server.py` with `selected-model.json`, explicit host/port (free port), no `--open`, key in memory only, ownership checked with protected `/v1/models`.
- Approval policy is in the Rust host; aionrs always receives `tool_approve` scope `once`.
- Workbench MCP is stdlib-only Python (officecli + workspace_info) using Strata's venv; search/memory/browser/SSH/voice from the spec are not yet built.
- Stage 0 experiments and benchmarking skipped by request.
