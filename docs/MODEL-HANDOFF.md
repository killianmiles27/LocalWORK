# Model handoff for the local desktop app

Completed 15 October 2026 on this Windows PC. This chat installed and benchmarked the model runtime; the app itself was not implemented. Treat the supplied app specification as background and use these verified integration facts for this pinned runtime.

## Selected model and configuration

**Use Swift 1.5 Qwen3.8-Flash-Next GSQ-RCO IQ2_XS, ukisai, with a 1024-token thinking budget.** This is one general-purpose model, retaining all 48 × 512 = 24,576 routed experts. Normal routing selects ten experts per layer per token. MTP is enabled. Both downloaded model candidates retain their full expert sets.

Canonical config: `C:\Random\Working Folder\LocalWORK\benchmark\configs\selected-model.json`. It is an exact copy of `results\swift-iq2_xs-budget1024\config-tested.json`. Use it rather than reconstructing flags from an older specification.

Swift scored **19/24 strict whole-task successes** with and without the cap. Original ISTA Q2_0 scored 16/24 in each of three tested configurations. The cap fixes Swift's two empty writing responses and reduces ordinary answer time, but two Word documents become two pages. Thus the cap trades layout successes for writing successes; it is not a universal quality improvement. The initial 21/24 and every-task-type-at-least-2/3 heuristic was **not met**. Selection is the best measured balance, with the failures below retained.

Full comparison: [BENCHMARK-REPORT.md](<C:/path/to/LocalWORK/benchmark/BENCHMARK-REPORT.md>). Selected results: [RESULTS.md](<C:/path/to/LocalWORK/benchmark/results/swift-iq2_xs-budget1024/RESULTS.md>).

## Installation and exact paths

| Item | Verified location / version |
|---|---|
| Strata | `C:\Random\Working Folder\LocalWORK\strata`, stable `v0.1.44.1` verified at installation |
| Source revision | `296b59d2f73c8f04a805df29c2fa97655adace78` |
| Windows CUDA 13 engine | `C:\Random\Working Folder\LocalWORK\strata\engine\strata.exe` |
| Engine SHA256 | `bd18453f65b4d03b15de6100b1a9226426266560779b51b9265de176ae8f34d4` |
| Python 3.14 venv | `C:\Random\Working Folder\LocalWORK\strata\.venv\Scripts\python.exe` |
| Underlying Python | `C:\Users\you\AppData\Local\Python\pythoncore-3.14-64\python.exe` |
| Private NVIDIA DLL directory | `C:\Random\Working Folder\LocalWORK\strata\.venv\Lib\site-packages\nvidia\cu13\bin\x86_64` |
| Swift GGUF directory | `C:\Ai Models\models\swift-IQ2_XS` |
| Swift native pack / tokenizer | `C:\Ai Models\packs\swift-iq2_xs` / its `tokenizer` subdirectory |
| Shared MTP runtime | `C:\Ai Models\mtp\rt` |
| Routing profile | `C:\Random\Working Folder\LocalWORK\strata\data\expert-profile.bin` |
| Original Q2_0 weights / pack | `C:\Ai Models\models\Q2_0` / `C:\Ai Models\packs\q2_0` |
| Benchmark evidence | `C:\Random\Working Folder\LocalWORK\benchmark` |

Swift's two files are `Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00001-of-00002.gguf` and `Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00002-of-00002.gguf`. Both raw shards remain required at runtime even with the pack. The config uses shard 1 for both `--native` and `--ple-gguf`; do not copy the original Q2_0's shard-2 PLE setting onto Swift.

Pinned Swift Hub revision: `b22d729eae29b5796f76fb70f91aef549b9fc52c`.

| Shard | Bytes | SHA256, fully verified after download |
|---|---:|---|
| 1 | 39,788,473,344 | `ca3b302d3d1eb6eddce3ea4acc79854e6cc5fdc0583e374a6a8b6bb67327743b` |
| 2 | 28,363,693,824 | `e4996a6de18fd49c58d9a0040fcfd73787db6407c51973f29884bee7b14c9dbb` |

The official setup reuses the original MTP for Swift; this installation follows that path. Native pack inventory checks and exact-conversion records are in `results\swift-iq2_xs\expert-inventory.json` and `swift-setup.log`. Model source/license links are in [MODEL-SOURCES.md](<C:/path/to/LocalWORK/benchmark/MODEL-SOURCES.md>); the weights have their own licenses, separate from Strata's software license.

## Hardware and runtime settings

Ryzen 5 7600, 6 cores / 12 threads; RTX 4060 Ti 16GB, 16,380 MiB reported, driver 616.92, PCIe 4.0 ×8; two 16GB DDR5 modules configured at 6000 MT/s; approximately 31.08 GiB Windows-usable RAM; WD_BLACK SN850X 1TB NVMe, C: / PhysicalDrive1. Windows 11 Home build 26200. No hardware, driver, power-plan or page-file settings were changed. Windows automatically grew its managed page file during the work.

The selected config keeps 32,768 context allocation, low-RAM mapped experts, `--expert-cache auto`, `--prefill auto`, `--spec 4`, `--spec-min-p 0.5`, shared MTP and `--kv int8`. Calibration was run on the underlying model/hardware config; the cap changes server thinking control, so calibration and nonthinking throughput are explicitly reused.

Keep these environment settings from the config:

- `STRATA_ROUTE_TAIL_SKIP=0`: required here to retain all routed contributions. Upstream's default 7 omits some low-ranked missed contributions.
- `STRATA_FILE_RELEASE=1`: documented Windows working-set hint after completed expert uploads. It does not guarantee dropping file cache or reducing committed memory. Original Q2_0's separate full trial showed better observed memory/speed with equal aggregate strict success, subject to uncontrolled cache/background variation.

`--trim-stage-weights` is ignored on this single-GPU setup. Do not add it as a claimed optimization.

## Launch and API contract

This PowerShell command reproduces the selected service launch:

```powershell
& 'C:\Random\Working Folder\LocalWORK\strata\.venv\Scripts\python.exe' 'C:\Random\Working Folder\LocalWORK\strata\serve\server.py' --engine strata --config 'C:\Random\Working Folder\LocalWORK\benchmark\configs\selected-model.json' --host 127.0.0.1 --port 8080
```

Pass host/port explicitly: direct server launch otherwise defaults to 8095; config `port` alone does not select the listener. The app should launch and track its owned process tree, with a hidden window for background operation. Omit `--open`.

Base URL: `http://127.0.0.1:8080`. Actual served model ID: `swift-1.5-iq2_xs`; request alias `strata` was accepted throughout scoring. OpenAI-compatible `POST /v1/chat/completions` streaming was exercised with these request settings:

```json
{
  "model": "strata",
  "messages": [{"role": "user", "content": "User message"}],
  "temperature": 0,
  "reasoning_effort": "medium",
  "max_tokens": 4096,
  "stream": true,
  "stream_options": {"include_usage": true}
}
```

The selected config supplies `reasoning_budget_tokens: 1024`. It is an opt-in cap on private thinking: Strata injects a wrap-up/closing tag and resumes generation when reached, which can add processing overhead. It is not a guarantee of unchanged reasoning quality on harder tasks. Request-level `reasoning_budget_tokens` can override it; alternatives are not the selected default. Reasoning-effort labels alone are instructions, not hard thinking limits. These measurements use greedy decoding; the author's sampled example (temperature 1.0, top-p .95, top-k 20) was not benchmarked.

Handle separate `reasoning_content` and final `content` SSE deltas. Function-call arguments may arrive fragmented; reassemble them, preserve tool-call IDs, and return tool results with the matching `tool_call_id`. Include thinking, retries and tools in elapsed completion time. The benchmark clients in `measure.py` and `agent_tasks.py` demonstrate the exercised protocol. Sampling controls are implemented; the older specification's claim that temperature is ignored is stale. Prefix reuse is implemented and observed, including thousands of cached tokens on agent turns; whole history is not necessarily reprocessed each turn.

Scoring used localhost without a key. The final selected config was separately launched with a random per-launch `STRATA_API_KEY`: `/v1/models` returned 401 with missing/wrong keys and 200 with the correct Bearer key. Actual metadata confirmed the expected Swift ID, 32768 context and text modalities. The key remained in memory and that server was stopped. Evidence: [selected-api-check.json](<C:/path/to/LocalWORK/benchmark/selected-api-check.json>).

**`/health` is public even when a key is enabled.** It returned 200 without a key. Health readiness does not prove key acceptance or server ownership. Track the owned process and verify a protected endpoint; do not terminate an unrelated listener merely because health answers. This corrects the supplied app specification's ownership-probe assumption.

## Measured performance

Medians of three repeats, except the separately labeled single capped-trial start. Raw throughput below is measured in uncapped Swift with thinking disabled, and explicitly reused for the cap because engine/hardware arguments are identical.

| Allocated context test | Actual input tokens | Decode tokens/s | Prompt tokens/s | First token / first final token | Entire 256-token window |
|---|---:|---:|---:|---:|---:|
| ~4K | 4,006 | 36.6 | 272.7 | 14.72 s | 20.94 s |
| ~16K | 16,045 | 39.1 | 438.7 | 36.63 s | 43.15 s |
| near-32K | 31,479 | 39.9 | 469.3 | 67.14 s | 73.35 s |

Fresh prompts have zero reused tokens. Near-32K reserves output room within 32768. The intentional 256-token length finish is expected only in these raw windows. It is not equivalent to successful quality-task completion.

Swift uncapped first measured readiness was 25.25 s; warm restarts 19.70/8.10/8.11 s, median 8.11 s. The capped trial's single readiness was 25.8 s. **True storage-cold startup was not measured.** OS/storage cache was uncontrolled; do not label first process start as cold.

Selected capped-task medians, including thinking and real tools:

| Task | Strict successes | First streamed token | First final-answer token | Complete task |
|---|---:|---:|---:|---:|
| Knowledge | 3/3 | 1.98 s | 8.87 s | 13.51 s |
| Arithmetic + logic | 3/3 | 2.18 s | 22.48 s | 38.26 s |
| Summary | 0/3 | 2.30 s | 26.83 s | 33.16 s |
| General writing | 3/3 | 1.59 s | 27.60 s | 34.83 s |
| Browser research | 3/3 | 5.07 s | 43.97 s | 63.96 s |
| Word document | 1/3 | 4.10 s | 65.62 s | 67.52 s |
| Coding + tests | 3/3 | 3.63 s | 41.71 s | 48.86 s |
| Multistep error recovery | 3/3 | 4.00 s | 20.66 s | 26.27 s |

Word failures are real readable two-page DOCX files, not missing outputs. All twelve tool workflows reached finals. Browser runs actually opened official pages in installed Edge; documents were created/reopened structurally and independently exported in installed Word. Fixed code tests ran both by the model and independently. Inventory tasks retried an explicitly injected EAGAIN, wrote exact JSON and reread it. Full ranges and all intermediate errors are in the detailed results.

## Resource pressure and integration limits

During Swift raw tests, minimum available system RAM was about 0.30–0.31 GiB. Peak model-tree RSS was 24.24/24.79/25.09 GiB at ~4K/~16K/near-32K, and peak whole-GPU use was 15,696/15,696/15,709 MiB. Mapped pages can be reclaimed; RSS/available RAM are not the same as unreclaimable committed memory. Nevertheless, this is a memory-constrained installation, and the complete app plus tools at maximum context was not tested.

Median physical C: reads per fresh request were 15.19/28.51/53.28 **decimal GB** at those contexts. Near-32K reads ranged 50.76–54.09 GB. Mean total CPU was roughly 43–44%; model-tree CPU roughly 3.5 logical cores. Two-second sampling can miss peaks; system/GPU/disk totals include background desktop activity. Model-tree RSS/CPU excludes separately launched browser/Word children. Process logical reads do not capture mapped-file hard faults; physical NVMe counters are reported separately. Per-task telemetry also remains in the raw/aggregate files.

Around 28.3 GB free remained on C: at final checks. Both downloaded candidates, packs and shared MTP are retained; no losing weights were removed. Avoid assuming room for more large downloads.

## Failures the app chat must account for

- All three selected summaries omit an explicit EUR 900/week cost after the temporary grant, despite giving the underlying EUR 900 cost, EUR 500 grant and EUR 400 grant-period net. Summaries are otherwise grounded and within length, but fail the frozen full-budget requirement. Check all required financial periods and source constraints.
- Two of three selected Word memos spill onto page two. Structural validation reports success but does not prove page layout. Give the agent real page-count/render feedback for a one-page requirement. Benchmark files were never manually repaired.
- Uncapped Swift wrote nothing in two general-writing runs after 4096 thinking tokens (~85 s). The selected cap produced three valid-length answers (256/232/263 words, ~30–44 s), while reducing one-page Word success from 3/3 to 1/3. Preserve this trade-off rather than combining the best cells into an untested success score.
- Browser answers are verbose and sometimes overstate device-bound portability in a table before explaining QR use later; Microsoft-specific recovery rules should not be generalized. Some coding runs recover from guessed/disallowed test paths. A final answer alone is insufficient evidence that every requirement succeeded.

These are small repeated practical tasks, assistant-reviewed against a frozen rubric, not blinded human ratings or broad intelligence benchmarks. No deep reasoning, multilingual, vision, parallel-agent or full production-app reliability claim is established.

Vision encoders, OfficeCLI and aionrs were not installed/integration-tested here. Health and model metadata report text-only input/output, images false and image generation false. The future app's own agent/tool stack still needs integration testing.

## Download stopping decision

Tested two model weight sets in the requested initial order, across five configurations and 120 scored task runs, plus 27 raw throughput windows. Swift is the best measured model; the cap wins the equal-score Swift comparison on ordinary-answer latency and avoiding empty writing responses. Original Q2_0 is faster at long-prompt ingestion and raw decode but has lower strict task success.

Original ISTA IQ2_XS was not downloaded. Its second shard is hash-identical to original Q2_0's retained 28.8 GB shard and could be reused; it would still need its distinct 39.23 GB first shard and preparation. One smaller supported alternative, Qwen3.6-35B-A3B UD-Q4_K_XL, was researched in [ALTERNATIVES.md](<C:/path/to/LocalWORK/benchmark/ALTERNATIVES.md>), but not downloaded or ranked. Stop further downloads for this handoff: current evidence gives a clear winner among tested models, while the remaining failures are explicitly reported. This does **not** prove either untested candidate would lose.
