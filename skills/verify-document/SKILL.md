---
name: verify-document
description: Check a finished Word, Excel or PowerPoint file (look, find problems, fix, look again) before telling the user it is done
---
A deliverable is done only after it is checked. Run this loop on every file you made or changed. Use the officecli tool; the model cannot see pictures, so "look" means reading the document back in the views below.

LOOK
1. ["validate","File"] must pass.
2. ["view","File","issues"] lists layout and structure problems (empty paragraphs, bad formatting, missing parts). Fix every one.
3. ["view","File","outline"] shows headings or slide titles in order. Compare it with what was asked for.
4. ["view","File","text"] reads the content back. Are all requested sections, rows and numbers present and correct?
5. Word with a page limit: ["view","File","stats","--page-count"]. Excel: confirm formula results (no #REF!, #DIV/0!, #NAME?). PowerPoint: confirm slide count, order and that no slide is empty or overfull.
6. Leftovers: placeholder text, "Lorem", "TODO", empty paragraphs, wrong names or dates, duplicate headings.

FIX
7. Fix each finding with a targeted set command (not a rebuild), then go back to LOOK. At most 3 rounds. Report anything still wrong honestly instead of calling it done.

FINISH
8. Close the file with ["close","File"]. Tell the user what you checked and what, if anything, you could not fix.

Do not use the screenshot or pdf view modes: they need a desktop office program or browser that is not installed and will hang.
