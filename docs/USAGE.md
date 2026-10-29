# Using LocalWORK

The ALPHA badge beside LocalWORK in the sidebar marks the app's current development stage.

## Models

The composer model menu lists your local models. Hover, click, or use Right arrow on a local model to open its profiles beside it. The menu opens on the other side or shows profiles in place when the window is narrow, and stays within the window when resized. A profile change reloads the managed local engine. Choose which local profiles appear in **Settings → Model → Local models in your picker**; hiding keeps their files and editor entries.

Use **Settings → Model → Model library** to install/update PolyStrata, download a suggested model or add files already on disk. The same library is available during first-run setup. Download sizes and hardware-fit labels are estimates. Tuning uses upstream calibration for supported configurations and requires the model to be stopped.

## Start a chat in a folder

Choose a folder for the task using the folder control beside the composer. New chats otherwise use your configured projects location, normally `Documents\LocalWORK`. Each chat remembers its working folder.

Keep task files together. For an existing document, work on a copy until you trust the result. Attach a file using the attachment button, drag and drop, or paste. State which file should change and what should stay the same.

## Scanned PDFs and photos

`read_attachment` can read images and PDF pages with an empty or very short text layer using local OCR. Install **Tesseract OCR** with English language data; scanned PDFs also require **Poppler's `pdftoppm`**. On Windows, install the Windows executables (`tesseract.exe` and `pdftoppm.exe`); on Linux use your distribution's Tesseract and Poppler packages. Put them on PATH, install them in the optional layout described in `vendor/README.md`, or set `LOCALWORK_TESSERACT` and `LOCALWORK_PDFTOPPM` to their executable paths before launching LocalWORK. Explicit overrides take precedence, then vendor tools, then PATH. A bad override must be corrected or unset.

OCR runs locally: neither the image nor the recognised text is sent to an OCR service. PDF pages with usable text are not OCRed. At most 10 sparse pages are OCRed per call, within a shared 60-second OCR/rendering deadline; skipped or failed pages are identified. Temporary page images are removed after the call. The result is returned in character ranges like other attachments; requesting another range repeats extraction and the same page cap, so it does not advance past skipped pages. OCR defaults to English (`eng`); set `LOCALWORK_OCR_LANG` to installed Tesseract language codes such as `eng+fra` to override it.

OCR is approximate: machine-recognised text is labelled and may omit or misread words, numbers or layout. Check the original before relying on it. OCR in `read_attachment` does not make scanned PDFs searchable in the local index.

## Reusable task templates

Write a prompt, select the working folder, then choose **Save as task template** above the composer. Give it a name and confirm the folder. You can optionally choose a document template file (for example Word or Excel), or use a current attachment; the first attached Office document is selected by default and can be removed. Without a selected chat folder, choose one in the save dialog.

Saved tasks appear as compact buttons above the composer. Click one to open a new, empty chat with its prompt prefilled and its working folder selected; nothing is sent until you press Send. An optional document is copied into that folder's `attachments` directory using a new filename if needed, just like ordinary attachments. The source file is not changed. Each chat uses the saved folder, not a new subfolder.

Use the pencil or trash button beside a saved task to rename or delete it. Templates are stored locally across restarts. Keep the saved folder and source document at their original locations: if either is missing or a copy fails, LocalWORK shows the affected path and leaves your current chat/draft unchanged instead of starting a broken chat. Rename/delete only affects the saved task, not existing chats or copied files.

## Find and organise chats

The sidebar groups chats into Pinned, Today, Yesterday, Previous 7 days, Previous 30 days and Older. Search chats at the top of the sidebar to match titles and message text. Hover over a chat to pin, rename, export or delete it. You can also double-click its title to rename it.

Markdown downloads include saved thinking, tool arguments, stored tool output, statuses and timestamps. Thinking and tool details are collapsible in Markdown viewers that support HTML details. Tool output may already have been shortened when stored. Review the export before sharing it: it can contain local paths and file contents.

## Edit a message or regenerate a reply

Hover over one of your messages and choose Edit. In an empty composer, Up arrow edits your last message. Sending the edited text removes that message and everything after it, and the chat continues from there. Regenerate on the last reply asks the same question again. Files the assistant already changed are not undone. Both actions wait until the current reply has finished, so stop it first if needed. Very long chats that were summarized cannot go back past the summary.

## Check my work

After a reply that created or changed a workspace file, choose **Check my work** beneath the reply. LocalWORK starts a new chat in the same folder and sends the latest request and detected file paths, not the previous conversation or its reasoning. The assistant is asked to re-read the files and sources, report mismatches and verification gaps, and not modify deliverables unless you explicitly ask in the new chat.

The action uses successful file-tool signals; changes made through other tools may not be detected. It is not a correctness guarantee: review the findings and any missing sources or unreadable files. If creating the chat fails, your current chat and draft remain available.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+N | New chat |
| Ctrl+K | Search chats |
| Ctrl+B | Show or hide the sidebar |
| Ctrl+, | Settings (Model, Tuning, Plugins, Connections, App) |
| Up arrow (empty composer) | Edit your last message |
| Enter / Shift+Enter | Send / new line |
| Esc | Cancel an edit or clear the search |

If you close the window while a task is still running, LocalWORK asks before quitting, because quitting stops the task.

## Give it a clear task

Include the result you want, the input files, important limits, and how you will judge completion. For example:

> Read the attached quarterly figures. Create an Excel summary with one row per month and a total row, then write a short explanation of the largest changes. Save both files in this folder. Ask me if a required number is missing.

The assistant can research, use websites, edit files, and create documents. It should verify its work, but you still need to review facts, calculations, citations, and layout. A file appearing in the panel does not establish that its content is correct.

## Working efficiently with data and documents

Spreadsheet attachments initially return a compact profile instead of a full cell dump. The assistant can inspect selected ranges, aggregate CSV/TSV/Excel tables and reuse saved results to build documents. Ambiguous dates require an explicit format; blank, nonnumeric or formula-error inputs are not silently summed as zero. Stored Excel formula caches may be stale; evaluated range reads and comparisons check calculations separately from file validity. Changes to a source invalidate saved comparisons.

Reusable recipes create new Word reports or Excel tables/charts, optionally copying a source workbook. They refuse to overwrite an existing target. A one-page layout is a formatting preset; pagination still needs checking. Custom layouts and edits remain available through OfficeCLI. The recipes contain no task-specific categories, dates, recommendations or business rules.

For traceable numbers, ask the assistant to load `sources-on-numbers`. Evaluated `officecli` range datasets retain the source path and SHA-256, sheet, original range, data-row cell ranges and formula locations. The first row is a header unless explicit columns are supplied. `tabular` inspection and aggregation return bounded `sources` for computed figures; saved aggregates retain figure references and validate the source chain on reuse. CSV/TSV row numbers are logical records (a quoted multiline record counts once); JSON rows are dataset row positions. Whole-file datasets and older JSON datasets without cell references are identified at row level, not as exact cells. Grouped calculations include the group and measure columns when cell references are available. Check both `sources_truncated` and the reference `truncated` flag; omitted references are not a complete source list.

For a Word report or Excel table, pass `office_recipe` a `sources` array with each figure's `figure`, `value`, and `references` (each reference includes a `file` or URL and, as applicable, `sheet`, `range`, `rows`, `cells`, or `page`). The recipe adds a Sources section or notes; a declared figure with no references is labelled `source not supplied`. Unreferenced spreadsheet formulas are also marked, with values shown as not evaluated. The assistant must declare figures in document prose explicitly; the builder cannot detect all numbers in free text or verify caller-supplied citations. Sources notes are text, not clickable provenance UI; clickable navigation is not included in this change.

For planned work, the assistant can mark an established procedure as execution to use low reasoning effort on the native local provider. Analysis, verification, a tool error or a new task restores configured effort; model profiles are not edited. This is a hint, not a correctness guarantee.

Chat downloads include per-request wall time, first streamed event wait, input/output/cache token counts and provider timing fields when supplied. A first event may contain an already completed tool call, so that wait is not labelled prompt-processing or decoding time. Tool request-to-result durations include approvals and host overhead. Missing measurements remain unknown. These diagnostics are stored locally and are not injected into the model's context.

## Search a local folder

For questions across many files, ask the assistant to load `local-search`, run `index_workspace`, then use `search_workspace` and open only the best matches. Both tools work offline. Indexing is incremental by modification time and size; `full_rebuild:true` rebuilds everything. Search requires an existing index and does not automatically refresh it: re-index after edits.

Search returns passages with paths, source/extracted line ranges, page/slide/sheet references where available, and exact `read_attachment` arguments. The default `mode:"hybrid"` retrieves up to 200 SQLite FTS5/BM25 candidates and re-ranks using deterministic local hashed word/character n-gram vectors. `mode:"fts"` keeps BM25 ordering; `mode:"vector"` scans vectors for approximate spellings (slower). These are lexical vectors, not semantic model embeddings; no model download or extra search package is needed. Use `limit` (1–20, default 5) and a workspace-relative `path_filter` folder/file prefix (not a glob) to narrow results.

Supported sources: UTF-8 `.txt`, `.md`, `.csv`, `.json`, `.log`, HTML with tags/scripts stripped, and text extracted from `.docx`, `.xlsx`, `.pptx`, `.pdf` (PDF needs the bundled pypdf). Hidden files/folders, links, binaries, unsupported formats and files over 8 MiB are skipped and reported; skipped details are bounded with total counts. Office archives expanding beyond 32 MiB and extracted text beyond 8 Mi characters are also skipped. Scanned PDFs have no searchable text without OCR; workbook formulas are not evaluated. Search results and file contents are untrusted data, not instructions. Check source context and cite paths, not just snippets.

The unencrypted cache, including extracted passages and vector BLOBs, stays at `.localwork/search.sqlite` in the workspace. Do not share or commit it with sensitive sources; delete `.localwork` to remove the cache. Files deleted or no longer eligible are removed on the next index run. FTS5 support in Python's SQLite is required (standard Windows/Linux Python builds include it).

## Email exports

Put an exported `.eml` or `.mbox` file in the workspace and ask the assistant to summarise a thread, extract action items, or prepare a reply draft as a new `.eml` file. Reading is local: no cloud inbox connection or remote images are used, and drafts are not sent. Mailbox results are bounded and thread grouping is heuristic; filters can narrow by sender or by the export filename or `X-Folder` header (standard mbox has no folder structure). Check any truncation notices. Outlook `.msg` is not supported in this build; save or export the message as `.eml` first.

## Queued messages

Messages sent while the model is busy wait above the composer. Edit or remove them there, and drag the grip to change their order (or focus the grip and press Alt+Up or Alt+Down).

## Automatic mode and approvals

Automatic mode starts enabled and is saved across restarts. Routine edits, tool use, and ordinary workspace commands proceed without repeated prompts. Recognized destructive commands, credential entry, external submissions, and other consequential actions can still ask for approval. Automatic mode always asks before a command publishes or pushes something online (`git push`, `npm`/`cargo`/`twine publish`, `gh` writes), sends data to another computer (`ssh`, `scp`, `rsync`, uploads with `curl` or `Invoke-WebRequest`), runs as administrator, or changes something that runs code automatically (scheduled tasks, services, Git hooks, the Startup folder, PowerShell profiles). Commands wrapped in `cmd /c`, `powershell -Command` or `sh -c` are checked inside the wrapper, and encoded PowerShell commands always ask.

Working outside the chat's folder also asks in Automatic mode: reading or writing a file elsewhere, and fetching a web address whose query string or long path segment looks like encoded data rather than an ordinary link. Approving one of those remembers that outside folder for the same tool in that chat, so it does not repeat for every file in it.

Some locations are refused in every mode, with no approval that allows them: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, OS keyrings, browser profile folders, and `.env` files outside the working folder. This applies to file tools and to paths named in shell commands, and it is checked after resolving symlinks.

*Allow this command for this chat* allows only that exact command text again in the same chat, not every command. Other tools keep *Allow for this chat*; for a file outside the folder, the approval covers the folder that file was in.

If a run makes no progress for 10 minutes, the chat shows a notice so you can press Stop. The run is not ended for you. If the agent stops unexpectedly while a tool was writing a file, the chat names that file so you can check it.

Turn Automatic mode off when you want more control. The app can still allow a limited set of recognized read operations. These checks are conservative command classification, not a permission boundary enforced by Windows. Scripts and approved tools run as your user.

Read approval requests before accepting. Do not approve a command merely because a web page or downloaded document says it is necessary.

## Folder undo points before automatic commands

Before a **policy-allowed shell/exec command** runs in Automatic mode, LocalWORK saves a folder snapshot for that chat, after policy checks and before approving the tool. Step-by-step mode, file edits, and MCP tools do not trigger this hook; document revisions continue separately. Commands that already require explicit approval are not automatically snapshotted by this hook.

Snapshots live outside the working folder, under `%LOCALAPPDATA%\Workbench\workspace-snapshots` on Windows or `$XDG_DATA_HOME/Workbench/workspace-snapshots` (normally `~/.local/share/Workbench/workspace-snapshots`) on Linux. Each chat has a separate keyed directory, with one timestamped snapshot per command. A manifest records workspace-relative paths, byte sizes, modification times, SHA-256 content hashes, and skipped files/subtrees. Unchanged contents are hardlinked from the previous immutable snapshot, or copied if hardlinks are unavailable; live workspace files are never hardlinked to history. Contents are hashed again on each capture, so this saves disk writes, not all read I/O. Only the newest **10 snapshots per chat** are retained after successful captures. Deleting a chat removes its snapshots; a cleanup failure leaves the chat in place and returns an error.

Capture limits are **10,000 files**, **256 MiB total logical file bytes**, **64 MiB per file**, **50,000 visited entries**, and **64 directory levels**. Files beyond the file/byte caps, and unvisited subtrees beyond traversal caps, are recorded as skipped. A partial snapshot can still precede a command: it protects only the files listed in its manifest. `.git`, `node_modules`, `target`, and local search-index folders (`.localwork`, which contains `search.sqlite`, plus `.localwork-index`, `.search-index`, `.workbench-index`) are excluded at every depth. All symlinks and Windows reparse points are skipped, including links within the folder; links outside it are never followed. Special files are skipped. App data and the snapshot store are never included. Selecting a working folder that contains app data, or is inside app data, makes capture fail instead of storing snapshots inside the working folder. Unsupported/non-portable filenames also cause capture to fail.

If capture fails (for example, insufficient disk space, a permission error, or a file changing during capture), that command becomes a one-time approval request: **“Could not snapshot the folder before this command”**, with the underlying reason. Approving it explicitly runs without a folder undo point. Failed captures do not publish a partial snapshot; interrupted staging directories are ignored and reclaimed on the next capture.

### Backend restore commands (no snapshot UI yet)

These Tauri IPC commands are for user actions only and are **not agent/MCP tools**:

- `workspace_snapshots_list({ id })`: returns newest-first manifests for the chat, including skipped entries.
- `workspace_snapshot_restore({ id, snapshot, exact: false })`: restores the listed file contents and returns `{ restored, deleted }` relative-path lists. `snapshot` is an ID from the list. Omitting `exact` also means `false`. Files created after the snapshot are **not deleted** by default.
- `workspace_snapshot_restore({ id, snapshot, exact: true })`: explicitly requests deletion of additional eligible regular files in the working folder. Excluded folders are still untouched; empty directories are not removed. Exact restore is refused if the snapshot has skipped entries or the current folder cannot be fully traversed safely.
- `workspace_snapshots_cleanup({ id })`: removes that chat's snapshots, including leftover staging data. This also works with the original chat ID after the chat is gone, for cleanup after an interrupted deletion. It does not remove working files.

Stop the chat's current reply before restore or cleanup. Restore checks every manifest path and content hash before any writes, rejects absolute/dot/traversal paths and symlink/reparse-point escapes, and replaces each file using a temporary file in its destination directory. It never links restored files to stored history. It does not provide an all-files transaction: a later I/O failure can leave some files restored; the error includes the completed paths. File/directory type conflicts may require manual resolution. Restore is content-only: ownership, ACLs, permissions/executable bits, original timestamps, and empty directories are not restored. Manifest modification times are informational.

These are local undo points, not independent backups or a filesystem sandbox. Other applications can still change files during capture/restore, and hostile concurrent link/path swaps are not isolated by the operating system. Snapshots can contain private workspace content and are not encrypted. Keep independent backups for important work.

## Files and previews

Completed documents appear in the Files panel. You can preview a file, open it in its normal application, save a copy, or inspect saved revisions. Use the document panel's revision request to describe the next change.

Current Word, Excel and PowerPoint previews let you edit text immediately: click and type, then click away to save. Esc cancels the current edit. You can also select text and leave a note for the assistant. Earlier revisions stay read-only. This supports text and cell edits, rather than every layout feature available in Office. Text files still have an Edit/Save control.

Use the zoom buttons or slider, Ctrl+mouse wheel, Ctrl++/Ctrl+- and Ctrl+0 inside an Office preview. Zoom changes the preview only, from 25% to 250%.

Editing and saving files does not start the AI. Saved edits accumulate in the file pane with an optional **Check related files** button. Finish as many edits as you like, click away to save, then click the button if you want the assistant to check other project documents for dependencies such as participant quantities, budget formulas or quoted totals. The button is available when saves have finished and the assistant/model is ready. A check combines the accumulated edits, preserves your composer draft, and appears as a message in the chat. Failed checks stay available for another click; model recovery, ordinary chat messages and navigation do not trigger them. Pending edits are held per chat while the app stays open. External Office edits are not tracked. Review any resulting AI changes; ambiguous relationships need clarification.

The built-in OfficeCLI recipe is supplied at the start of every chat. Normal batches use inline JSON without creating project files. Large batches use a hidden temporary folder and clean their input file after success or failure. Legacy hidden `.*.build.json` files are omitted from the file picker; ordinary JSON documents remain visible and existing files are not deleted.

Office previews are HTML approximations. Supported direct edits save previous document versions. Automatic shell commands use the separate folder undo points described above; they do not add individual document revisions. Keep independent backups for important work.

For Word, Excel, and PowerPoint, the assistant can bundle structural checks into one verification call. Page counting is a separate Word-dependent check and may fail. Open the finished document in its normal application for final layout review.

## Browser and web access

The browser works in the background. You can follow tool activity in the chat and request screenshots. Sessions are separate from your everyday browser and can persist in a project profile.

Web searches and page requests leave the PC. Disable web tools in Settings → Connections for local-only file work, or turn on **offline mode** there to keep LocalWORK itself off the internet: web, browser and SSH tools are refused, and the plugin store and update checks do nothing. A chat you use while offline mode is on stays offline after you turn it off; opening it shows *Keep offline* or *Allow internet* so you decide per chat. This setting controls the built-in web tools; it is not a firewall and does not stop a shell command, update check, or SSH connection from using the network.

Browser profiles may contain login cookies. Treat the data folder as sensitive. Private-address filters are incomplete for browser subrequests; use a VM or separate Windows account when browsing untrusted sites on a sensitive network.

## Long tasks, context, and stopping

The context circle shows an estimate of the model's current context usage. An unavailable reading is shown as unknown. During generation, a displayed measurement may be from the preceding request.

Automatic compaction summarizes earlier work at 80% of the selected context window. When the selected Strata server advertises native compaction, both the Compact button and automatic compaction use that endpoint. Recent complete turns and tool results are retained; older turns become a summary. Failed or cancelled compaction leaves the original history in place. Other servers use the generic checkpoint summarizer. A smaller summary leaves more room for the next steps, but details can be lost. If a task goes off track, stop it and give a specific correction or start a fresh chat with the relevant files.

If native compaction cannot shorten a long first request, the agent can checkpoint earlier completed work within that request and continue. It preserves the user requests and the latest two complete assistant/tool exchanges, then checks the replacement with the native service before saving it. An incomplete summary or a replacement that still leaves too little reply space is rejected; the saved history is retained.

The live thinking panel follows new text automatically. Scrolling up inside it pauses following; returning to its bottom resumes it. This works independently of scrolling the main chat.

An output limit is separate from a full context window. If a response reaches that limit, or a supported native local model repeats a long reasoning passage, LocalWORK can retry twice with tools still available and reduced reasoning for the recovery request. The original request and confirmed tool results remain available. Recovery notices separate interrupted text from the resumed response; repeated failure ends with an explicit incomplete notice.

The assistant must update plan steps using confirmed results. Before accepting a final answer, a plan with unfinished steps gets one opportunity to finish the work or update its status. If work remains unfinished, the plan reads **Plan paused** when the run stops; it is never automatically marked complete. A later unrelated question does not restart that old task.

Use **Stop** to interrupt a run. Completed writes are not undone. Review the working folder before restarting a task that was interrupted during an edit or download.

## Voice and SSH

The microphone transcribes a recording locally with whisper.cpp. Review the text before sending it. The tidy-up action uses the local model to rephrase it.

SSH is optional. Add a host in Settings, install the app's public key on the server, and verify its host-key fingerprint through a trusted channel. Read-only auto-approval is a separate choice for each host. Use a restricted server account and backups; LocalWORK does not make remote administration risk-free.

## Where data lives

- App settings, chats, logs, browser profiles, caches, and folder snapshots: `%LOCALAPPDATA%\Workbench` on Windows; `$XDG_DATA_HOME/Workbench` (normally `~/.local/share/Workbench`) on Linux.
- Deliverables and attachments: the chat's working folder.
- Model weights and Strata: the locations you selected, outside the app installation.

Chats and browser profiles are not encrypted by the app. Uninstalling normally keeps app data unless you explicitly select its deletion. Project files and model installations are separate; removing a chat is not a secure erase of every related file.
