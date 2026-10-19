---
name: model-tuning
description: Tune the local Strata model for this PC - measure the hardware, choose the best engine settings, and write speed/context profiles (Sprint, 64K, 128K, 256K) the user can switch between in the mode picker
---
Goal: the largest useful context at the best speed this PC can hold, as a few profiles the user picks from. Settings matter a lot: the same PC went from a 16K context at 30 tokens/s on the setup defaults to 256K at 40+ tokens/s after tuning. Never claim a gain you did not measure.

LIMITS (always)
- Never download a model, change drivers, the page file, power plans or BIOS settings, or reboot. If one of those would help, say what and why, and let the user decide.
- Never start a second Strata server. The app runs the model; you write profile files and the user switches to them.
- Never edit a profile's exe, cwd or lib_dirs. Only args, env and the sampling/reasoning fields change.
- Back up any file before you overwrite it (copy to <name>.bak-<yyyyMMdd-HHmm>.json).
- If settings.json has "modelSource": "server", the user runs their own server; tuning it is outside this skill. Say so.

1. FIND THE SETUP (ExecCommand, PowerShell; read only)
- App settings: Get-Content "$env:LOCALAPPDATA\Workbench\settings.json". strataRoot is the Strata folder; modelConfig is the profile in use.
- The current profile: Get-Content <modelConfig>. Note args, env, reasoning_effort and sampling.
- Hardware: nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv; (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; (Get-CimInstance Win32_Processor).Name, NumberOfCores; Get-CimInstance Win32_PageFileUsage (AllocatedBaseSize, MB); free disk on the Strata drive.
- Engine flags: read <strataRoot>\docs\DETAILS.md (search for the flag names below) and, if present, run <strataRoot>\engine\strata.exe --help. Prefer what this Strata version documents over this list.
- Recent speed: Select-String -Path "$env:LOCALAPPDATA\Workbench\logs\strata-server.log" -Pattern "done:" | Select-Object -Last 15. Lines read like "done: 654 tokens in 20 s (33.5 tok/s) ... expert cache 71.3% hit (+4.2% ... over PCIe)". Prompt reading shows as "reading the prompt: N of M tokens".
- Existing profiles: Get-ChildItem <strataRoot>\profiles\*.json (the folder may not exist yet).

2. CHOOSE SETTINGS (the levers, biggest first)
- RAM expert cache, --resident-budget-gib N: experts the GPU cannot hold are kept in locked RAM instead of read from disk. This was the biggest win. Measured on a 64 GB PC with a 16 GB card: 14 GiB for 16K, 12 for 64K and 128K, 10 for 256K (longer contexts need RAM too). Elsewhere start from N = RAM GiB minus 50 for 16K, 2 less for 64K/128K, 4 less for 256K, never below 4; treat it as a starting point to measure, not a result. Add --resident-experts. The engine clamps a budget that does not fit and says so in the log; if it clamps, lower N.
- KV cache precision, --kv int8: halves the context memory with no measured quality loss; use it on every profile.
- Context, --max-context: 16384, 65536, 131072, 262144 for the four profiles. Above 128K on a 12-16 GB card add --kv-resident 32768 (keeps the recent attention in VRAM, streams the rest).
- Draft tokens, --spec 2 --mtp <dir> (keep the --mtp path the current profile uses): spec 2 for normal profiles, spec 3 for the fast one. Add --spec-min-p 0.5. spec 4 is usually slower on 12-16 GB cards.
- VRAM reserve, --vram-reserve-mib: 1536 for normal profiles, 1024 for the short fast one. If the log says "LOW: requests may stall; add --vram-reserve-mib N", use that N.
- Keep --expert-cache auto and --prefill auto. Add --adapt-async 1 and, on Windows, --host-core last.
- env (strings): STRATA_FILE_RELEASE "1", STRATA_PF_FUSED "1", STRATA_RAM_ADAPT "32", STRATA_RESIDENT_HEADROOM_GIB "6". STRATA_ROUTE_TAIL_SKIP "7" only on the fast profile (it trades a little quality for speed); "0" elsewhere.
- Sampling 0.6 temperature / 0.95 top_p / 20 top_k; reasoning_effort "high". Keep idle_unload_s from the current profile.
- Remove flags the new ones replace: --mmap-experts (implied by the budget) and old --fit_max_tokens style limits.
- Page file: with 64 GB RAM or less, a long context may need a larger page file (32-96 GiB). Recommend it; do not change it.

3. WRITE THE PROFILES
- New-Item -ItemType Directory -Force "<strataRoot>\profiles". For each profile, start from the current profile JSON (keep every field), replace args/env/sampling, and save as <strataRoot>\profiles\<Name>-Sprint.json, -64K, -128K, -256K (Name = the model's short name, for example Swift). Optional fifth: -Overnight, the 128K profile with spec 3 for long unattended jobs.
- Write JSON with Set-Content -Encoding utf8 (or ConvertTo-Json -Depth 10) and read it back to check it parses.
- Profiles in that folder appear in the mode picker under the model. To give them friendly names and descriptions, also write a plugin: "$env:LOCALAPPDATA\Workbench\plugins\<name>-profiles\plugin.json":
  {"id":"<name>-profiles","name":"<Name> profiles","version":"1.0.0","description":"Tuned speed and context profiles for this PC","contributes":{"modes":[{"id":"128k","group":"<Name>","label":"<Name> · 128K","description":"Daily driver","config":"${strataRoot}/profiles/<Name>-128K.json"}]}}
  with one entry per profile.

4. MEASURE (with the user)
- You cannot restart the model mid-chat. Ask the user to pick a profile in the mode picker, then send one fixed test: "Write a 600-word explanation of how a heat pump works." (thinking off if the mode allows).
- After each run read the newest "done:" line: tokens/s, expert cache hit %, PCIe share. Run each profile twice and keep the second (cached) number; report first and second separately.
- If a profile fails to start, read the last 40 lines of strata-server.log, fix that one setting (usually a lower --resident-budget-gib or a higher --vram-reserve-mib) and ask the user to try again.

5. REPORT
- Write a short note in the workspace (model-tuning.md): hardware, each profile's settings, measured tok/s, what was not measured, and recommended page file or driver changes still open.
- Tell the user which profile to use day to day (usually 128K), which for quick answers (Sprint) and which for huge documents (256K).
