---
name: document-template
description: Produce a Word, PowerPoint or Excel result in the format of a template or example file the user attached (company letterhead, memo, report, slide master)
---
The attached file is the format. Its letterhead, header, footer, margins, fonts, styles, tab stops and numbering are copied by keeping the file itself, not by imitating it. Never rebuild the template from scratch.

UNDERSTAND
1. read_attachment the file once to learn what it is. Then, with the officecli tool: ["view","attachments/Template.docx","text"] lists every paragraph with its path (/body/p[N]); ["view",...,"outline"] shows header and footer. For PowerPoint use "text" for shapes per slide; for Excel ["view",...,"text"].
2. Decide which parts are fixed (letterhead, headers, footers, signature layout, labels such as "SUBJECT:") and which are example content to replace. If the user only said "use this format", sample text in the template (names, dates, example paragraphs, instructions about the format) is content to replace, not text to keep. Rules written inside the template (for example "double space between paragraphs") are formatting instructions: follow them.

COPY
3. Copy the template to a new file named for the result, with ExecCommand: Copy-Item -LiteralPath 'attachments\Template.docx' -Destination 'Memo - Subject.docx'. Never edit the attachment itself.

FILL (one batch where possible; paths are 1-based and shift after add/remove)
4. Replace text in place so the paragraph keeps its formatting: {"command":"set","path":"/body/p[10]","props":{"text":"SUBJECT:  Your subject"}}. A tab inside text is \t; keep the template's tabs so columns still line up.
   A paragraph with mixed formatting (a bold label followed by normal text) has runs: set each run, /body/p[N]/r[M], instead of the whole paragraph, or the bold is lost.
5. Need more paragraphs of the same kind? Clone a formatted one, then set its text: {"command":"add","parent":"/body","from":"/body/p[14]","after":"/body/p[14]"} creates p[15]. Clone the blank spacer paragraphs too when the template separates paragraphs with empty lines.
6. Remove leftover example paragraphs from the bottom up so earlier paths do not move: {"command":"remove","path":"/body/p[24]"}, then p[23], ... Keep the spacing the template uses before signature blocks.
7. PowerPoint: duplicate a slide whose layout fits with {"command":"add","parent":"/","type":"slide","from":"/slide[2]"} and set its shapes' text (/slide[N]/shape[M]); remove example slides. Excel: keep the sheet layout and set values/formulas in the existing cells; do not change the template's formatting.
8. After each batch run ["view",File,"text"] again before the next batch, because paths may have changed.

CHECK
9. Load verify-document and run it. Also compare against the template: the header, footer and letterhead are unchanged, no example text, dates or names from the template remain unless the user wants them, and paragraph numbering is continuous. Close the file and call show_document.
10. Tell the user which file you made from which template, and list any details you had to leave as placeholders (names, office symbols, signatures). Never invent a signature, rank, office symbol or date the user did not give; use a clear placeholder instead.

If the attachment is a PDF or image of a template, it cannot be copied. Say so, and build the closest match with the normal officecli recipe, listing what may differ.
