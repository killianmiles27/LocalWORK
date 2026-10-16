---
name: intelligent-ui
description: Interactive explanations, dashboards, comparisons, calculators and small tools using Open Intelligent UI.
---

Use the `assemble_document` tool with `title`, `description`, and `html` (an HTML
body fragment with optional inline style and script). LocalWORK displays it with
Open Intelligent UI's bundled theme, form styling, and SVG helper classes.

Use text for simple answers; existing show_chart/show_table tools for basic data;
interactive UI when changing inputs, filtering data or exploring a mechanism helps.
Label sample data and assumptions. Never invent retrieved facts or citations.

Theme colors: var(--color-text-primary), var(--color-text-secondary),
var(--color-background-primary), var(--color-background-secondary),
var(--color-border-tertiary), plus semantic info/success/warning/danger variants.
Use var(--font-sans), var(--font-serif), var(--font-mono). Form controls are styled.
SVG helper classes: .box .node .arr .leader, text .t .ts .th, and color ramps
.c-purple .c-teal .c-coral .c-pink .c-gray .c-blue .c-green .c-amber .c-red.

Every enabled control must work. Validate input, bounds, finite numbers and zero
divisors. State units. Include reset and accessible labels. Respect reduced motion.
Use textContent for untrusted values. Use inline SVG, canvas or vanilla JavaScript;
no CDN imports, fetch, remote images/fonts, credentials, or filesystem access.

`sendPrompt(text)` offers a follow-up to the user. Only call it from a deliberate
click. The host shows the suggestion for review; it never sends automatically.
There is no openLink bridge, cross-widget storage, or external application access.
Do not claim a message was sent or a file saved because a widget displayed it.

For saved deliverables create an actual file with Write/OfficeCLI and call
`show_document` with its relative path. Artifacts persist in the conversation;
they are not automatically workspace files. Keep existing calculations and
requirements when revising; make a new widget rather than pretending to patch one.

Adapted from CopilotKit/OpenIntelligentUI at
8391a94c1c3939c679e40ddd7bfc08a9ef690e70 (MIT). The unmodified upstream
response playbook and license are bundled in this directory for provenance.
