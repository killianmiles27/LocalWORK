# Using LocalWORK

## Start a chat in a folder

Choose a folder for the task using the folder control beside the composer. New chats otherwise use your configured projects location, normally `Documents\LocalWORK`. Each chat remembers its working folder.

Keep task files together. For an existing document, work on a copy until you trust the result. Attach a file using the attachment button, drag and drop, or paste. State which file should change and what should stay the same.

## Give it a clear task

Include the result you want, the input files, important limits, and how you will judge completion. For example:

> Read the attached quarterly figures. Create an Excel summary with one row per month and a total row, then write a short explanation of the largest changes. Save both files in this folder. Ask me if a required number is missing.

The assistant can research, use websites, edit files, and create documents. It should verify its work, but you still need to review facts, calculations, citations, and layout. A file appearing in the panel does not establish that its content is correct.

## Automatic mode and approvals

Automatic mode starts enabled and is saved across restarts. Routine edits, tool use, and ordinary workspace commands proceed without repeated prompts. Recognized destructive commands, credential entry, external submissions, and other consequential actions can still ask for approval.

Turn Automatic mode off when you want more control. The app can still allow a limited set of recognized read operations. These checks are conservative command classification, not a permission boundary enforced by Windows. Scripts and approved tools run as your user.

Read approval requests before accepting. Do not approve a command merely because a web page or downloaded document says it is necessary.

## Files and previews

Completed documents appear in the Files panel. You can preview a file, open it in its normal application, save a copy, or inspect saved revisions. Use the document panel's revision request to describe the next change.

Office previews are HTML approximations. Supported direct edits save previous versions, but arbitrary shell commands do not always participate in that history. Keep independent backups for important work.

For Word, Excel, and PowerPoint, the assistant can bundle structural checks into one verification call. Page counting is a separate Word-dependent check and may fail. Open the finished document in its normal application for final layout review.

## Browser and web access

The browser works in the background. You can follow tool activity in the chat and request screenshots. Sessions are separate from your everyday browser and can persist in a project profile.

Web searches and page requests leave the PC. Disable web tools in the setup wizard for offline file work. This setting controls the built-in web tools; it is not a firewall and does not stop a shell command, update check, or SSH connection from using the network.

Browser profiles may contain login cookies. Treat the data folder as sensitive. Private-address filters are incomplete for browser subrequests; use a VM or separate Windows account when browsing untrusted sites on a sensitive network.

## Long tasks, context, and stopping

The context circle shows an estimate of the model's current context usage. An unavailable reading is shown as unknown. During generation, a displayed measurement may be from the preceding request.

Automatic compaction summarizes earlier work at 80% of the selected context window. When the selected Strata server advertises native compaction, both the Compact button and automatic compaction use that endpoint. Recent complete turns and tool results are retained; older turns become a summary. Failed or cancelled compaction leaves the original history in place. Other servers use the generic checkpoint summarizer. A smaller summary leaves more room for the next steps, but details can be lost. If a task goes off track, stop it and give a specific correction or start a fresh chat with the relevant files.

Use **Stop** to interrupt a run. Completed writes are not undone. Review the working folder before restarting a task that was interrupted during an edit or download.

## Voice and SSH

The microphone transcribes a recording locally with whisper.cpp. Review the text before sending it. The tidy-up action uses the local model to rephrase it.

SSH is optional. Add a host in Settings, install the app's public key on the server, and verify its host-key fingerprint through a trusted channel. Read-only auto-approval is a separate choice for each host. Use a restricted server account and backups; LocalWORK does not make remote administration risk-free.

## Where data lives

- App settings, chats, logs, browser profiles, and caches: `%LOCALAPPDATA%\Workbench`.
- Deliverables and attachments: the chat's working folder.
- Model weights and Strata: the locations you selected, outside the app installation.

Chats and browser profiles are not encrypted by the app. Uninstalling normally keeps app data unless you explicitly select its deletion. Project files and model installations are separate; removing a chat is not a secure erase of every related file.
