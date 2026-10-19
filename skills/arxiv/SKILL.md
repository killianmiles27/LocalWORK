---
name: arxiv
description: Find and read scientific papers on arXiv by topic, author, category or ID, with BibTeX or APA references
---
Adapted from Hermes Agent's arxiv skill (MIT, Nous Research).

arXiv has a free API that needs no key. It returns Atom XML.
- Search: web_fetch https://export.arxiv.org/api/query?search_query=all:large+language+models&max_results=10
  Prefixes: ti: (title), au: (author), abs: (abstract), cat: (category, e.g. cat:cs.AI), all:. Combine with +AND+, +OR+, +ANDNOT+; exact phrase ti:%22chain+of+thought%22. Newest first: &sortBy=submittedDate&sortOrder=descending. Next page: &start=10.
- Papers by ID: https://export.arxiv.org/api/query?id_list=2402.03300,1706.03762
- Abstract page: https://arxiv.org/abs/<id>. Full text: https://arxiv.org/pdf/<id> (fetch with a focused max_chars and read the sections the question needs, not the whole paper).

From each <entry> take the title, authors, published date (first 10 characters), the ID (the <id> URL after /abs/) and the primary category. Show results as a short numbered list: [ID] Title - first authors - date - one line on what it does.

References:
- BibTeX: @article{<LastName><Year>_<id without dot>, title={...}, author={A and B}, year={...}, eprint={<id>}, archivePrefix={arXiv}, primaryClass={<cat>}, url={https://arxiv.org/abs/<id>}}
- APA: Author, A., & Author, B. (Year). Title. arXiv. https://doi.org/10.48550/arXiv.<id>

arXiv papers are preprints: say so when a claim rests on one, and look for a peer-reviewed version when it matters. Keep to about one API request every 3 seconds.
