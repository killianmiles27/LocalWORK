# Launch and discoverability plan (free channels only)

Written 4 November 2026, while LocalWORK is in alpha (v0.1.x, Windows x64 only). The repo had 0 stars, 0 forks, 1 open issue, no Discussions and no homepage URL at the time of writing. Nothing here assumes a budget, an audience or a marketing hire. The plan runs for six weeks: three of preparation, launch week, two of follow-up. Everything below is a suggestion for the owner; only this document was added to the repo.

## The pitch

LocalWORK is a free, open-source Windows desktop assistant that runs the language model on your own PC. Point it at a folder, say what you want, and it reads the files and writes real `.docx`, `.xlsx` and `.pptx` documents in a pane beside the chat, with editable previews, revisions and folder undo points. There is no account, no subscription, no usage limit and no Docker: one installer, a model you choose, and the Office work happens on your machine. It is alpha software, built by one person with heavy AI assistance, and it says so in the README: local model quality depends on your graphics card and model choice, long tasks can go wrong, and the output needs checking.

Taglines that stay inside that truth: "Your files, your PC, real Word and Excel documents"; "An Office assistant that runs on your own graphics card"; "Local models that finish the document, not just the paragraph". Do not use "ChatGPT killer", "fully offline", "air-gapped" or "private by design" (see the guardrails).

## Who this is for

| Segment | What they need to see | Where they already are | What kills the click |
| --- | --- | --- | --- |
| Privacy-sensitive Office users: finance, legal, HR, consultants, small businesses | A spreadsheet turned into a report without uploading it; offline mode; an honest list of what still leaves the PC | Search, LinkedIn, Office-adjacent subs, word of mouth | A cloud account prompt, a Docker command, or a privacy claim the docs contradict |
| Local-LLM hobbyists | GGUF models, Strata/PolyStrata, hardware requirements, real numbers on real hardware | r/LocalLLaMA, HN, X, local-LLM Discords | Fake benchmarks, "beats GPT", Linux/macOS builds that do not exist |
| Windows developers and tinkerers | Apache-2.0 source, Tauri/Rust + TypeScript, Python tools, plugin and MCP surface, folder snapshots | GitHub search, awesome lists, HN, r/Windows11 comment threads | A repo that does not build, no issues answered, alpha software with no caveats |

The first segment is the one LocalWORK can own. The other two are credibility: hobbyists test hard and file good bugs; developers read the source and decide whether the alpha is worth their time.

## Repo discoverability

### Description

Already set and good (138 characters, under GitHub's 350 limit):

> Local-first AI desktop assistant for Windows: chat with your files and build real Word, Excel and PowerPoint documents on your own PC.

Keep it until a landing page exists, then add the page URL as the repo homepage (currently empty). Alternate if the pitch changes: "Windows desktop AI for Office work: runs a local model, reads your files, writes real Word, Excel and PowerPoint documents. Alpha, Apache-2.0." The description must not say "offline" unqualified, "secure" or "private": inference is local; web tools, downloads and updates are not.

### Topics

Current list (20, the GitHub maximum): `ai-agents`, `ai-assistant`, `desktop-app`, `docx`, `gguf`, `llamacpp`, `llm`, `local-ai`, `local-first`, `local-llm`, `localai`, `mcp`, `office-automation`, `offline-ai`, `pptx`, `privacy`, `rust`, `tauri`, `windows`, `xlsx`.

Every tag is accurate except one overlap worth fixing. `localai` duplicates `local-ai` in meaning and reads as the name of a different project (mudler/LocalAI), which invites confused clicks. Replace it with `microsoft-office`, which is what the app actually produces and how the Office audience searches. That is the only change: the list is full, and swapping is cheaper than arguing for a 21st slot.

Final list: `ai-agents`, `ai-assistant`, `desktop-app`, `docx`, `gguf`, `llamacpp`, `llm`, `local-ai`, `local-first`, `local-llm`, `mcp`, `microsoft-office`, `office-automation`, `offline-ai`, `pptx`, `privacy`, `rust`, `tauri`, `windows`, `xlsx`.

Notes for the owner: `llamacpp` is supported indirectly (models are GGUF, the docs list the llama.cpp port among compatible servers), but LocalWORK ships Strata/PolyStrata rather than llama.cpp itself, so drop the tag if Strata is not llama.cpp-derived. `privacy` is kept because keeping files on the PC is the point, but the README has to defend it. Future candidates if a slot frees: `document-generation`, `word`, `excel`, `powerpoint`, `windows-desktop`. Do not add `rag` (the index is lexical FTS5 plus hashed vectors, not embedding RAG) or `ai` (too broad to rank).

The API replaces the whole list, so write the body first:

```bash
# save this as topics.json first
{"names":["ai-agents","ai-assistant","desktop-app","docx","gguf","llamacpp","llm","local-ai","local-first","local-llm","mcp","microsoft-office","office-automation","offline-ai","pptx","privacy","rust","tauri","windows","xlsx"]}
gh api -X PUT repos/killianmiles27/LocalWORK/topics --input topics.json
```

### README first screen

The current first screen beats most alpha projects: logo, name, tagline, four badges, a link row, a full-width GIF of real Office work, then a plain-language paragraph. It already names the model engine, credits upstream, and calls itself "vibe-coded slop". Keep the tone. Three changes:

1. Put the alpha status in the first screen as a sentence, not only a grey badge: "Alpha: Windows x64 only, built with heavy AI assistance, and long tasks can fail. Try it on a copy of your files." Readers who miss the caveat become angry issue writers.
2. Add one sentence a stranger can repeat: "It writes real Word, Excel and PowerPoint files, not markdown." Office output is the differentiator.
3. Keep the GIF near 5 MB with real alt text, and keep "Heads up" within one scroll of the top or linked from the first screen. GitHub lazy-loads, but a 30 MB GIF still hurts on mobile.

### Assets to make

- Social preview, 1280×640 PNG under 1 MB: wordmark, one-line pitch, "Windows · alpha · Apache-2.0". Set it in repo settings; it is what most link previews show.
- Three demo clips, 20–30 seconds, 1080p: MP4 plus a GIF under 8 MB for the README (scripts below). Record at 100% scaling on a 1920×1080 display with a real model on named hardware.
- One 60–90 second narrated overview for YouTube and LinkedIn: the same three clips plus a 10-second install.
- Three stills at native resolution: chat beside the spreadsheet, the Folder history panel, Settings with offline mode on.
- Captions (`.srt`) for every video; autocaptions mangle "Strata" and "PolyStrata". Commit a short `docs/media` note with the machine, GPU, model and version behind each clip.

No fake data, no stock footage, no benchmark overlays, no speed-up without a visible "2× speed" label. Use synthetic files, not the owner's real finances.

### Discussions and Issues

- Enable Discussions with Announcements (release notes, known issues) and Q&A (setup, hardware). Keep bugs in Issues so they stay linkable and closable.
- Add a bug template: version, Windows build, GPU and VRAM, model and quant, what was attached, expected vs actual, and whether a redacted chat export is attached. The README asks for this in prose; a template makes it happen.
- Labels: `alpha-known`, `needs-info`, `hardware`, `office-output`, `security`, `docs`. Pin one issue: "Start here: alpha limitations, known bugs, how to report".
- Keep private vulnerability reporting on, linked from the pinned issue. SECURITY.md already points at GitHub advisories; confirm the form is enabled before launch.
- Answer every issue in the first two weeks, even "reproduced" or "cannot reproduce on this GPU". Silence reads as abandonment in a 0-star repo.

## Free channels

Effort and impact are for this repo at its current size, not a funded startup. Impact is what a first attempt can realistically produce: a few hundred views and a handful of real users, not a front page.

| Channel | Effort | Realistic impact | Rules that decide whether it survives |
| --- | --- | --- | --- |
| GitHub topics + README + releases | Low | Steady, compounding | Accurate tags only, no keyword stuffing, release notes that say what broke |
| Awesome lists (`janhq/awesome-local-ai`, `tauri-apps/awesome-tauri`) | Low–medium | Small, durable | One entry per list, exact format, description ends with a period, no badge walls, one PR, wait a week before pinging |
| Hacker News "Show HN" | Medium | High variance, can be zero | Must be tryable; no landing-page-only posts; title starts "Show HN:"; answer comments for hours; never ask for votes |
| r/LocalLLaMA | Low | Medium–high for hobbyists | Use the project/showcase flair, disclose authorship, put specs and limits in the post, answer hardware questions |
| r/selfhosted, r/Windows11, r/artificial | Low | Likely zero | A desktop app is off-topic in r/selfhosted; self-promotion rules are strict elsewhere. Ask the mods first or skip |
| Product Hunt | High | Low–medium | Needs a product page, gallery, maker comment and a community that shows up; a Windows-only alpha often underperforms |
| LinkedIn | Low | Low–medium | Personal post, one GIF, plain language, no hashtag walls, no engagement pods; expect reach inside your own network |
| X | Low | Low–medium | 20-second clip, short thread, `#localllama`; do not tag large accounts for reach |
| YouTube | Medium | Low at first, durable | 60–90 seconds, real audio, chapters, alpha caveat in the description; benchmark videos need real numbers |
| Newsletters, blogs, GitHub Pages write-up | Medium | Medium if accepted | Use public submission forms (TLDR AI, Ben's Bites, Console.dev for dev tools); no pay-for-play; expect silence |

### Posting norms

- Write the post for the site, not from a template. r/LocalLLaMA wants hardware and quant; HN wants what you built and what is broken; LinkedIn wants a story.
- Disclose authorship in the first line everywhere. "I built this" changes how a mod reads it.
- Lead with the constraint (Windows x64, alpha, 12 GB+ VRAM recommended) instead of burying it. The people you want read it and still click.
- Post once per channel, then stop. A second post is for a real release with new information, not another attempt at attention. Stagger across five to seven days; same-day cross-posting looks like a campaign.
- Reply to every substantive comment for the first six hours and link the release, not a signup form. There is nothing to sign up for, which is the point.

### What gets rejected as spam

- Link-only posts with no context, or the same text pasted across subs; accounts that only post about one product.
- "Check out my app" titles with no problem statement, screenshots or limits.
- Vote requests in the post, in DMs or in a Discord. Product Hunt rings and HN vote pods are detectable and cost the account.
- Bought stars, star-for-star, bot comments, AI-written replies that say nothing.
- Editing a post after it lands to add a link; deleting and reposting the same URL within weeks; cold-posting in someone else's support thread; @-mentioning Jan, Ollama or LM Studio maintainers to borrow attention.

## Six-week calendar

Assumes the app is finished enough for a public binary at the start of week 0. If it is not, shift the table and do not launch early.

| Week | Goal | Concrete actions |
| --- | --- | --- |
| −3 | Repo passes the 60-second test | Clean-VM install/uninstall; fix installer and first-run bugs; set description, topics, social preview; enable Discussions and templates; save a baseline (traffic CSV, downloads, issue count). Then record the three clips and stills with hardware notes |
| −2 | Write once, reuse | Draft the Show HN, r/LocalLLaMA, LinkedIn and YouTube posts from the same three beats; have someone who has never installed it read the README first screen and say what the app does |
| −2 | Prepare the release | Tag it, upload installer and `latest.json`, verify the signature, add a SHA-256 file, release notes with known issues; pin the "Start here" issue |
| −1 | Dry runs and readers | Post to one small channel first (an awesome-list PR or a blog post) and fix what breaks; test every link and the security form; ask five people outside the project to install it, fix the top two confusing steps, and do not ask them for stars |
| 0 | One clear launch day | Release and pinned issue Monday; Show HN Tuesday or Wednesday morning US Eastern; r/LocalLLaMA the next day; LinkedIn and X with the 20-second clip; YouTube the 90-second cut; answer everything for two days |
| +1 | Turn attention into reports | Triage every issue within 24 hours; ship one patch for the top installer/Office bug; post "what broke and what I fixed" in the pinned issue; thank merged awesome-list maintainers |
| +2 | Second wave, smaller | One newsletter submission, one blog post ("how the Office tools keep spreadsheet numbers straight"), one short from existing footage; write a one-page retro from the metrics section |

Do not launch during a holiday week or the week of a major model release. A quiet Tuesday beats a busy Friday.

## Launch-day checklist

Release and repo:

- [ ] Installer attached, signed, with `latest.json` and SHA-256 checksum
- [ ] Release notes list fixed issues and known limitations, link to SECURITY.md
- [ ] README first screen current: version badge, GIF, alpha sentence, download link
- [ ] Description and 20 topics set; social preview uploaded
- [ ] Pinned issue: limitations, how to report, where data lives, private security link
- [ ] Discussions open and issue template live; `docs/media` recording notes committed

Content:

- [ ] Three captioned 20–30 second clips (release assets or YouTube), plus a 90-second overview with "Strata" and "PolyStrata" spelled correctly
- [ ] Synthetic demo files; no personal data visible in any frame
- [ ] Every claim checked against README, USAGE.md and SECURITY.md
- [ ] One honest "what is broken" paragraph in each post

Distribution:

- [ ] Show HN draft: "Show HN: LocalWORK – a Windows app that writes real Word and Excel files with a local model"
- [ ] Reddit drafts for the one or two subs that allow it; mod permission where rules are unclear
- [ ] LinkedIn and X an hour apart; YouTube description with alpha caveat, hardware note and repo link

Measurement:

- [ ] UTM links on every post that leaves GitHub (`?utm_source=hn&utm_medium=social&utm_campaign=alpha-launch`), pointing at a page you control
- [ ] Free analytics on that page (GoatCounter or Plausible CE); GitHub's traffic page shows referrers but not UTM values
- [ ] Baseline saved before the first post (views, uniques, clones, downloads, issue count), and a hand-kept tally of "installed and made a document"

Support:

- [ ] Two hours blocked after each post, and same-day issue replies for two days
- [ ] Known-good previous installer kept; reply template for "does it work on my GPU" that links the requirements instead of guessing

## Metrics

| Watch | Where | Why it matters |
| --- | --- | --- |
| Views, unique visitors, referrers, clones (14-day window) | Insights → Traffic | Which channel actually sent people, not which one made noise |
| Release asset downloads per version | Release page / `gh api` | Closest free proxy for installs; compare across versions |
| Issues opened and answered within 24h | Issues | A launch that produces reports is working; silence is not |
| Quality of reports (version, GPU, model, reproduction) | Issues | Shows whether the pinned issue and template work |
| Referral split by channel | Landing-page analytics | Decides where week +2 effort goes |
| Self-reported "first document created" | Comments/issues | The only metric that matches the pitch |

Ignore HN points and comments, X impressions and likes, Product Hunt rank, LinkedIn reactions, star count compared with Jan or Ollama, GitHub views without referrers, downloads without version breakdown, and any awareness number that does not lead to an issue or a document. Stars are a lagging side effect: 0 stars with ten real bug reports is healthier than 200 stars and no installs. A quiet launch is not a failure: free channels are cumulative. Do not buy stars, run engagement pods, or add a star-history chart to the README until the history is worth charting.

## Honest-claims guardrails

1. **Alpha, every time.** Say "alpha", "Windows x64 only", "expect bugs", "check the output". No roadmap promises in public replies; "macOS later" only if it is actually planned.
2. **AI-assisted is not a secret.** The README says "vibe-coded slop" in the owner's words. "Built by one person with heavy AI assistance" is enough; no claims of a team, a company or years of engineering.
3. **Local model quality varies.** Never promise quality without naming GPU, VRAM, model, quant and version. "Faster than you can read" stays attached to its hardware caveat.
4. **No invented benchmarks.** No tokens/sec without a documented measurement, no "beats GPT" charts, no screenshots borrowed from other projects. "Feels fast on a 4090 with Qwen at Q4" is fine if it happened.
5. **No "ChatGPT killer".** Also no "better than Copilot", "replaces Office" or "enterprise-grade". The README says it will not beat the paid ones at everything.
6. **Privacy wording must match SECURITY.md.** Allowed: "inference runs on your PC", "no account or subscription", "offline mode stops the app's web tools, plugin store and update checks". Not allowed: "fully offline", "air-gapped", "no data ever leaves your PC", "encrypted", "sandboxed". SECURITY.md says searches, browsing, downloads, updates and SSH contact external systems, chats and browser profiles are not encrypted, and approval checks are not an OS sandbox. Quote the docs rather than paraphrasing.
7. **Limits are part of the pitch.** Folder undo is "undo points before automatic shell commands, up to 10 per chat", not a backup. Office previews are HTML approximations, page counts need Word, and formula caches can be stale: "real .docx/.xlsx/.pptx files", not "pixel-perfect Office".
8. **Cite every comparison.** If a competitor fact is not in that project's own README, write "unknown" or leave it out.

## Comparison table

Only facts stated in each project's own README or LICENSE on 4 November 2026. "Unknown" means the README did not say; it does not mean the feature is missing. Verify before publishing; projects change.

| Project | License (own repo) | Runs on (own README) | Install shape (own README) | Chat with your files (own README) | Creates .docx/.xlsx/.pptx (own README) |
| --- | --- | --- | --- | --- | --- |
| LM Studio | Closed source; no public application repo (the `lmstudio-ai` org hosts SDKs, docs and a bug tracker) | Unknown — no app README to cite | Unknown | Unknown | Unknown |
| Jan | Repository LICENSE (GitHub reports "Other"; copyright Menlo Research) | Windows, macOS, Linux (`.exe`, `.dmg`, `.deb`, `.AppImage`) | Desktop installer; Microsoft Store and Flathub links | Not stated in README | Not stated in README |
| AnythingLLM | MIT | Desktop for macOS, Windows, Linux; Docker/self-hosted | Desktop download or Docker; multi-user is Docker-only | Yes — "Chat with your docs"; PDF, TXT, DOCX and others | Not stated; DOCX listed as an input format |
| Open WebUI | Open WebUI License (BSD-3-based, preserves branding); prior contributions under original licenses | Anywhere Python 3.12 or Docker runs; separate desktop app for macOS, Windows, Linux | `pip install open-webui` or Docker | Yes — Knowledge Bases and folder sync (ecosystem section) | Not stated in README |
| LocalWORK | Apache-2.0 | Windows 10/11 x64 only; macOS and Linux not built or tested | Windows installer, no Docker, no account | Yes — workspace folder tools, attachments, local FTS5 search index | Yes — `.docx`, `.xlsx`, `.pptx` through OfficeCLI, editable previews |

Publish with this footnote: "LocalWORK is alpha. The other projects are mature and broader; LocalWORK is narrower on purpose (Windows, Office output, local models). Compare features, not vibes." No star counts in the table: popularity is not capability, and the numbers date the document.

## Three demo scripts

1080p, 30 fps, no cuts inside a beat, cursor visible, a real model. Short enough to autoplay as muted GIFs. Record on synthetic files.

### 1. Spreadsheet to Word/Excel report (30–35 s)

Setup: synthetic quarterly workbook in `C:\demo\q3`, Automatic mode on, model loaded.

1. (0:00) Files panel shows `q3-figures.xlsx`, one sheet, 12 rows.
2. (0:04) Type: "Read q3-figures.xlsx. Make an Excel summary with one row per month and a total row, then a short Word report explaining the three biggest changes. Save both here. Ask me if a number is missing."
3. (0:10) Show the wait at 4× with a visible "4×" badge, or cut to the plan panel; never hide that time passed.
4. (0:16) Excel preview opens beside the chat; click a total cell, show the formula, edit one number and click away to save.
5. (0:24) Click **Check related files**; the check reports that the report's quoted total no longer matches and names the file to fix.
6. (0:31) Open the folder; both files exist and open in Word/Excel.

Say: "It reads a compact profile of the sheet, not every cell, and checks the numbers it writes." Do not say "it understands your finances" or "always correct".

### 2. Folder undo after a bad command (25–30 s)

Setup: a scratch folder with a few files, Automatic mode on.

1. (0:00) Ask for a deliberately wrong batch rename: "Rename every invoice in this folder to final.docx and overwrite."
2. (0:06) The command runs; the Files panel now shows one file.
3. (0:10) Open the chat header's **Folder history**; show the snapshot taken before the command, with file and skipped counts.
4. (0:16) Click **Restore** (not Exact restore), confirm, show the original names back.
5. (0:22) Say the limit out loud: snapshots cover automatic shell commands, 10 per chat, and this is not a backup.
6. (0:26) Note that step-by-step mode and file edits do not create these snapshots; document revisions are separate.

Say: "Undo points, not a time machine." Do not run the demo outside a scratch folder, and do not claim it protects every action.

### 3. Offline mode staying off the internet (25–30 s)

Setup: Settings → Connections open, offline mode off, a chat that has already used web search.

1. (0:00) Turn **offline mode** on; show the settings page explaining what stops.
2. (0:06) In a chat, ask: "Search the web for today's copper price." The tool is refused with a reason; show the message.
3. (0:12) Ask something local: "Summarise the attached notes into a one-page brief." It still works.
4. (0:18) Show that a chat started offline stays offline after the toggle is turned back off (*Keep offline* / *Allow internet*).
5. (0:23) Say the boundary: this is a tool setting, not a firewall; a shell command or SSH connection can still use the network. SECURITY.md says the same.

Say: "Offline mode stops LocalWORK's own web, browser, plugin-store and update traffic. It is not network isolation." Do not record a packet capture, claim "no packets leave the machine", or disable the Windows firewall for the shot.

## Do not do

- Do not post before the clean-VM install test passes.
- Do not buy stars, votes, followers or reviews, join star-for-star exchanges, or mass-DM maintainers, moderators or newsletter writers.
- Do not post the same text to five subreddits in one day, or repost a removed post without asking the mods why.
- Do not make privacy claims SECURITY.md does not support, in posts, README edits, captions or the description.
- Do not publish tokens/sec or "faster than X" without hardware, model, quant and version beside it.
- Do not use "ChatGPT killer", "Copilot replacement", "fully offline", "air-gapped", "secure sandbox" or "enterprise-ready".
- Do not claim macOS, Linux, mobile or multi-user support.
- Do not show real personal files, client names, balances or the owner's desktop in a recording.
- Do not promise a roadmap, a date or a fix in a public reply unless it is already scheduled.
- Do not delete critical comments or hide a bug report that embarrasses the demo.
