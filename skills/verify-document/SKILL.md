---
name: verify-document
description: Check a finished Word, Excel or PowerPoint file (look, find problems, fix, look again) before telling the user it is done
---
A deliverable is done only after it is checked. Run this loop on every file you made or changed. Use the officecli tool; the model cannot see pictures, so "look" means reading the document back in the views below.

LOOK
1. In one officecli tool call, pass ["verify","File"] (File must end in .docx, .xlsx or .pptx). This app-side wrapper runs validate, view issues, view outline and view text; for Word it also runs ordinary view stats. It is a wrapper, not a native OfficeCLI command.
2. For a Word page limit, explicitly pass ["verify","File","--page-count"]. This asks Word to repaginate and has a 20-second limit; if it times out or fails, the page count remains unverified. Report that limitation and do not claim the page limit is met.
3. Review each returned section separately. Validate must pass; inspect issues and fix every layout/structure problem. Compare the outline and extracted text with every user requirement, not just file validity: word/paragraph limits, section order, figure position, font sizes, page numbers and citations. Reconcile numeric claims and movement directions with the actual chart/source; a retrieved page can still contain incompatible estimates. For Excel check formula results (no #REF!, #DIV/0!, #NAME!); for PowerPoint confirm slide count/order and that no slide is empty or overfull. Reload the relevant format/task skill if its details were lost during compaction.
4. If any output says failed/incomplete, or is truncated, do not report verification as passed. Retrieve truncated individual views as needed. Retry a failed check only after addressing its cause; do not repeat Word repagination after a timeout or bypass its bound with a direct page-count command. Report the unresolved page limit. The bundle does not decide whether the content meets the assignment; use your judgment against the user's requirements.
5. Leftovers: accidental placeholder text, "Lorem", "TODO", empty paragraphs, wrong names or dates, duplicate headings. Clearly labelled draft placeholders for missing user identity/course details may remain; report them and never invent their values.

FIX
6. Fix each finding with targeted commands (not a rebuild), then repeat only the affected checks. Do not omit checks required by the user's request just to save tool calls. At most 3 rounds. Report anything still wrong honestly instead of calling it done.

FINISH
7. Close the file with ["close","File"]. Tell the user what you checked and what, if anything, you could not fix.

Use text, outline, issues and stats for the automated checks. Screenshot/PDF views may require an additional Office renderer; do not invoke them unless availability is verified. Report any unverified page layout instead of claiming pixel-perfect proofreading.
