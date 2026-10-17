---
name: academic-docx
description: Write an academic-style Word report with headings, citations, captions and a reference list
---
Follow the user's requested structure exactly. Do not add an abstract, numbered headings, or a conclusion to a short assignment unless requested.
1. Gather sources with the research skill. Cite in text as (Author, Year) and list every cited source under References. Use only sources actually read. Do not invent course readings or student/course details; mark missing identity details as placeholders in a draft and state what remains unresolved.
2. Build with officecli batch (see the built-in recipe). For APA student papers use a consistent permitted font (12pt Times New Roman or 11pt Calibri), double spacing, left-aligned body paragraphs, first-line indents, one-inch margins and page numbers. Use that same font size for the title, bold and centered. Use a separate title page when requested. The user's instructions override defaults.
3. APA figures: bold Figure 1 above the image, an italic descriptive title below the number, then the image, then a Note. with explanation and source attribution/citation. Include the source in References. Embed the requested image rather than a file link. Tables likewise use a number/title above.
4. References use a separate page, alphabetical order and hanging indents. Follow any user-specified section order and figure placement.
5. Honor the user's word, paragraph and page limits. Count the requested narrative separately from title/figure/references when appropriate. Total document words/pages do not establish the length of one section. Do not pad the document with unrequested sections.
6. Verify with the verify-document skill, close the file, and call show_document. Clearly identify a draft if readings, author details or final layout checks remain missing. Never claim submission or proofreading that was not performed.

APA figure guidance: https://apastyle.apa.org/style-grammar-guidelines/tables-figures/figures

Pinned OfficeCLI formatting examples for a batch:
- Body paragraph props: `{"font":"Times New Roman","size":"12pt","lineSpacing":"2x","firstLineIndent":"0.5in","spaceBefore":"0pt","spaceAfter":"0pt"}`.
- Reference paragraph props: `{"font":"Times New Roman","size":"12pt","lineSpacing":"2x","indent":"0.5in","hangingIndent":"0.5in","spaceAfter":"0pt"}`. A hanging indent also needs the left `indent`.
- Page numbers: `{"command":"add","parent":"/","type":"header","props":{"field":"page","align":"right","font":"Times New Roman","size":"12pt"}}`.
- A `pagebreak` added under `/` starts the next section. Add all sections in the requested order. An `image` under `/` with `src` and `width:"6.5in"` embeds the screenshot; do not use a bare numeric width.
