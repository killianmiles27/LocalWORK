---
name: blocked-pages
description: Recover a web page that will not load (403/429, paywall, Cloudflare or bot wall) from an archived copy or another route, and cite it correctly
---
Adapted from Hermes Agent's blocked-page-recovery skill (MIT, Nous Research).

Do not retry the same URL more than once. Work down this ladder, cheapest first, and stop at the first real copy.
1. Wayback Machine: web_fetch https://archive.org/wayback/available?url=<URL>. If archived_snapshots.closest.url exists, web_fetch that.
2. archive.today: web_fetch https://archive.ph/newest/<URL> (if it fails, try archive.md, then archive.li).
3. Same site, other door: an RSS feed (/feed, /rss), sitemap.xml, or a .json/api version of the page. Sites guard their HTML more than their data.
4. Another source: search for the same facts elsewhere (the original press release, an official page, a second outlet).
5. Last resort: the browser tool, only if the task needs this exact page.

Check the copy is real, not just a 200: it must contain the page's own title or expected text. Reject "Just a moment", "Attention Required" and "Redirecting" pages, tiny redirect stubs and rate-limit pages. Google Cache no longer exists; do not use it. Never use a generic web proxy.

Cite an archived copy as a snapshot with its date ("as archived 2026-08-06", from the timestamp in the snapshot URL), never as the live page. For current data (prices, availability, news) say that a snapshot may be out of date.
