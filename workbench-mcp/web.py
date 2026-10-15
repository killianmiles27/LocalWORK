"""Web tools for the workbench MCP server: web_search (DuckDuckGo) and web_fetch (page -> markdown, cached)."""
import hashlib, json, os, re, sqlite3, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "libs"))

CACHE_DIR = os.environ.get("WORKBENCH_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache"))
TTL = 6 * 3600


def _db():
    os.makedirs(CACHE_DIR, exist_ok=True)
    c = sqlite3.connect(os.path.join(CACHE_DIR, "web-cache.sqlite"))
    c.execute("create table if not exists pages(url text primary key, fetched real, title text, body text)")
    return c


def web_search(query, max_results=6):
    from ddgs import DDGS
    rows = DDGS().text(query, max_results=int(max_results))
    if not rows:
        return "No results."
    out = []
    for i, r in enumerate(rows, 1):
        out.append(f"[{i}] {r.get('title','')}\n{r.get('href','')}\n{r.get('body','')}")
    return "\n\n".join(out)


def _to_markdown(html, base):
    from bs4 import BeautifulSoup
    from markdownify import markdownify
    soup = BeautifulSoup(html, "html.parser")
    for t in soup(["script", "style", "nav", "footer", "header", "aside", "form", "noscript", "svg"]):
        t.decompose()
    title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
    main = soup.find("main") or soup.find("article") or soup.body or soup
    md = markdownify(str(main), heading_style="ATX")
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    return title, md


def web_fetch(url, max_chars=12000):
    if not re.match(r"^https?://", url):
        raise ValueError("url must start with http:// or https://")
    max_chars = int(max_chars)
    c = _db()
    row = c.execute("select fetched,title,body from pages where url=?", (url,)).fetchone()
    if row and time.time() - row[0] < TTL:
        title, body, note = row[1], row[2], "cached"
    else:
        import httpx
        r = httpx.get(url, follow_redirects=True, timeout=25,
                      headers={"User-Agent": "Mozilla/5.0 (LocalWORK research assistant)"})
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        if "pdf" in ctype or url.lower().endswith(".pdf"):
            import io
            from pypdf import PdfReader
            rd = PdfReader(io.BytesIO(r.content))
            title, body = url.rsplit("/", 1)[-1], "\n\n".join((p.extract_text() or "") for p in rd.pages[:40])
        elif "html" in ctype or "<html" in r.text[:500].lower():
            title, body = _to_markdown(r.text, url)
        else:
            title, body = url.rsplit("/", 1)[-1], r.text
        c.execute("insert or replace into pages values(?,?,?,?)", (url, time.time(), title, body))
        c.commit()
        note = "fetched"
    c.close()
    cut = body[:max_chars]
    more = f"\n\n[truncated, {len(body) - max_chars} more characters]" if len(body) > max_chars else ""
    return f"Title: {title}\nSource: {url} ({note})\n\n{cut}{more}"
