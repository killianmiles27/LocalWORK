---
name: officecli-basics
description: Create, check and style Word, Excel and PowerPoint files with the officecli tool
---
The full recipe lives in the assistant's built-in instructions (`src-tauri/system-prompt.md`).
Short version: create the file, then call `officecli` with `args: ["batch", "File.ext"]` and `commands: [{"command":"set", ...}]` to apply edits in one pass. Do not make a scratch JSON file. `--input <file>` remains available for an existing batch file. Check finished work with `args: ["verify", "File.ext"]`, review each returned section, and close the document when finished.
