"""Workbench MCP server (stdio, JSON-RPC 2.0, newline-delimited). Python stdlib only.
Tools: officecli (wrapper around the bundled OfficeCLI), web_search, web_fetch, workspace_info."""
import json, os, subprocess, sys

OFFICECLI = os.environ.get("OFFICECLI_EXE", "officecli.exe")
CREATE_NO_WINDOW = 0x08000000

TOOLS = [
    {
        "name": "officecli",
        "description": "Create, read and edit Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files with OfficeCLI. "
                       "Pass the CLI arguments as a list, e.g. [\"create\",\"report.docx\"], [\"view\",\"report.docx\"], "
                       "[\"validate\",\"report.xlsx\"]. Build documents fast with [\"batch\",\"file.docx\",\"--input\",\"build.json\"]. Paths are relative to the workspace. This is a tool, not a shell command.",
        "inputSchema": {"type": "object", "properties": {"args": {"type": "array", "items": {"type": "string"}}},
                        "required": ["args"]},
    },
    {
        "name": "web_search",
        "description": "Search the web (DuckDuckGo). Returns numbered results with title, URL and snippet. Cite sources by URL.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "max_results": {"type": "integer"}},
                        "required": ["query"]},
    },
    {
        "name": "web_fetch",
        "description": "Fetch a web page or PDF by URL and return it as readable markdown (cached for a few hours).",
        "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}, "max_chars": {"type": "integer"}},
                        "required": ["url"]},
    },
    {
        "name": "workspace_info",
        "description": "List files in the workspace folder (names, sizes).",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def call_tool(name, args):
    if name == "workspace_info":
        rows = []
        for root, dirs, files in os.walk(os.getcwd()):
            dirs[:] = [d for d in dirs if not d.startswith(".")][:50]
            for f in files:
                p = os.path.join(root, f)
                try:
                    rows.append(f"{os.path.relpath(p)}  {os.path.getsize(p)} bytes")
                except OSError:
                    pass
            if len(rows) > 300:
                break
        return "\n".join(rows[:300]) or "(empty workspace)"
    if name == "web_search":
        import web
        return web.web_search(args["query"], args.get("max_results", 6))
    if name == "web_fetch":
        import web
        return web.web_fetch(args["url"], args.get("max_chars", 12000))
    if name == "officecli":
        a = args.get("args")
        if isinstance(a, str):
            a = a.split()
        if not isinstance(a, list) or not a:
            raise ValueError("args must be a non-empty list of strings")
        r = subprocess.run([OFFICECLI, *map(str, a)], capture_output=True, text=True, timeout=120,
                           creationflags=CREATE_NO_WINDOW, stdin=subprocess.DEVNULL)
        out = (r.stdout or "") + (r.stderr or "")
        if r.returncode != 0:
            raise RuntimeError(f"officecli exited {r.returncode}\n{out[-4000:]}")
        return out[-20000:] or "OK"
    raise ValueError(f"unknown tool {name}")


def reply(id_, result=None, error=None):
    m = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        m["error"] = error
    else:
        m["result"] = result
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    method, id_ = msg.get("method"), msg.get("id")
    if id_ is None:
        continue  # notification
    if method == "initialize":
        reply(id_, {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {}}, "serverInfo": {"name": "workbench", "version": "0.1.0"}})
    elif method == "tools/list":
        reply(id_, {"tools": TOOLS})
    elif method == "tools/call":
        p = msg.get("params", {})
        try:
            text = call_tool(p.get("name"), p.get("arguments") or {})
            reply(id_, {"content": [{"type": "text", "text": text}]})
        except Exception as e:  # tool errors are results, not protocol errors
            reply(id_, {"content": [{"type": "text", "text": str(e)}], "isError": True})
    elif method == "ping":
        reply(id_, {})
    else:
        reply(id_, error={"code": -32601, "message": "method not found"})
