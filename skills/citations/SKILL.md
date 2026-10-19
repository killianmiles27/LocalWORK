---
name: citations
description: Cite every outside fact with numbered sources the reader can check; fact-check mode with verbatim quotes for medical, legal, financial or disputed claims
---
Adapted from Hermes Agent's grounded-citations skill (MIT, Nous Research).

The numbers and URLs come from what you fetched, never from memory.

1. Keep a source list in the workspace (sources.md) as you go: after each web_fetch you will use, add a line `[n] Title - URL (fetched YYYY-MM-DD)`. A number, once given, never changes. Do this before writing the prose that uses it.
2. Cite while drafting: put [n] right after the sentence the source supports, no space before it, at most 3 per sentence. Claims from your own knowledge get no number. Conflicting sources: give both readings, each with its own number.
3. A search snippet supports only what it literally says. If the claim needs the page body, fetch the page and cite that.
4. Quote figures, dates and names exactly as the source states them. Say "no source found for X" instead of smoothing a gap over.
5. End with a Sources list copied from sources.md, only the numbers the text cites. Never retype a URL from memory. In Word use a Sources section (or footnotes if the user wants them); in slides, a Sources slide.
6. Before delivering: every [n] in the text is in the list, every listed source is cited, and no URL appears that you did not fetch.

FACT-CHECK MODE (medical, legal, financial, safety, disputed claims, or when asked)
- For each source, copy into sources.md the exact sentence that carries the claim, from the fetched text. Copy, never retype or paraphrase; if you cannot find the sentence, the source does not support the claim.
- Mark a load-bearing claim you could not source with [unverified]. If many sentences need it, research more instead.
- One source is reporting; two independent sources are corroboration. When they disagree, cite both and say which you weight and why.
- Put the quotes under each source in the final Sources list.
