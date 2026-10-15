---
name: verify-document
description: Check a finished Word, Excel or PowerPoint file before telling the user it is done
---
A deliverable is done only after it is checked.
1. ["validate","File"] must pass.
2. ["view","File","text"]: read the content back. Are all requested sections, rows and numbers present and correct?
3. Word: ["view","File","stats","--page-count"] when there is a page limit. Excel: confirm the formula results. PowerPoint: confirm slide count and order.
4. Look for leftovers: placeholder text, empty paragraphs, wrong names or dates.
5. Fix with targeted set commands and repeat, at most 3 rounds. Report anything still wrong honestly.
6. Close the file with ["close","File"].
