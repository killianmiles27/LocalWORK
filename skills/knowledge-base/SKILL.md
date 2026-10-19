---
name: knowledge-base
description: Build and keep a linked markdown knowledge base (wiki) in the workspace from sources the user adds, and answer questions from it
---
Adapted from Hermes Agent's llm-wiki skill (MIT, Nous Research), after Andrej Karpathy's LLM wiki idea.

Layout, in a folder the user names (default wiki/):
- raw/ - sources as given (notes, fetched pages saved as .md, PDFs). Never edit these.
- pages/ - one .md per entity (person, company, product) or concept, plus comparisons and saved answers. Each starts with a line: `Sources: raw/a.md, raw/b.md | Updated: YYYY-MM-DD`.
- index.md - every page with a one-line summary, grouped by kind.
- log.md - one dated line per change ("2026-10-19 ingest raw/report.md: updated 3 pages, created 1").

Every session: read index.md and the last 20 lines of log.md before doing anything.

INGEST a new source: save it to raw/, read it, then update the pages it touches (add facts with their source; where it contradicts a page, keep both claims and mark the conflict). Create a page only for something that matters across sources, not for every name. Link pages with [[page-name]]. Update index.md and log.md.

QUERY: answer from the pages (read index.md first, then the pages it points to), cite the pages and raw sources, and say what the wiki does not cover. Offer to save a useful answer as a page.

TIDY when asked: find pages nothing links to, links to missing pages, stale "Updated" dates and unresolved conflicts; fix what is clear and list the rest.
