"""Browser tool for the workbench MCP server: drives a vendored Playwright CLI + headless Chromium.

One named browser session per conversation, one persistent profile per project (workspace folder).
Origin rules: loopback, link-local and private ranges are refused (checked here for navigation, and as
blocked origins inside the browser for every request, including page sub-requests)."""
import hashlib, ipaddress, json, os, re, shlex, socket, subprocess, sys, tempfile
from urllib.parse import urlparse

CREATE_NO_WINDOW = 0x08000000
NODE = os.environ.get("BROWSER_NODE", "node.exe")
CLI = os.environ.get("BROWSER_CLI", "")
BROWSERS = os.environ.get("BROWSER_BROWSERS", "")
PROFILES = os.environ.get("BROWSER_PROFILES", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".browser"))
SESSION = re.sub(r"[^A-Za-z0-9_-]", "", os.environ.get("BROWSER_SESSION", "default"))[:24] or "default"
TIMEOUT = 90

# Commands the model may run. No run-code, no state/cookie/route/storage commands.
ALLOWED = {
    "open", "goto", "snapshot", "click", "dblclick", "fill", "type", "press", "hover", "select", "check", "uncheck",
    "drag", "upload", "screenshot", "eval", "go-back", "go-forward", "reload", "resize", "console", "network",
    "tab-list", "tab-new", "tab-select", "tab-close", "close", "wait",
}
NAVIGATE = {"open", "goto", "tab-new"}

BLOCKED_ORIGINS = [
    f"{scheme}://{host}:*" for scheme in ("http", "https") for host in (
        "localhost", "*.localhost", "*.local", "*.internal", "0.0.0.0", "127.*", "10.*", "192.168.*", "169.254.*",
        "172.16.*", "172.17.*", "172.18.*", "172.19.*", "172.2*", "172.30.*",
        "172.31.*", "100.64.*", "metadata.google.internal",
    )
]


def _blocked_ip(ip):
    try:
        a = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return True
    if getattr(a, "ipv4_mapped", None):
        a = a.ipv4_mapped
    return (a.is_loopback or a.is_private or a.is_link_local or a.is_reserved or a.is_multicast or a.is_unspecified
            or a in ipaddress.ip_network("100.64.0.0/10"))


def check_url(url):
    """Refuse anything that is not plain http(s) to a public address."""
    if url == "about:blank":
        return
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("Only http:// and https:// addresses can be opened.")
    host = u.hostname
    if host.lower() in ("localhost",) or host.lower().endswith((".localhost", ".local", ".internal")):
        raise ValueError(f"Blocked: {host} is a local or private address.")
    try:
        infos = socket.getaddrinfo(host, u.port or (443 if u.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise ValueError(f"Could not resolve {host}: {e}")
    for info in infos:
        if _blocked_ip(info[4][0]):
            raise ValueError(f"Blocked: {host} resolves to a local or private address ({info[4][0]}).")


def _workspace():
    return os.getcwd()


def _profile_dir(suffix=""):
    key = hashlib.sha1(os.path.normcase(_workspace()).encode("utf-8")).hexdigest()[:12]
    d = os.path.join(PROFILES, key + suffix)
    os.makedirs(d, exist_ok=True)
    return d


def _headless_shell():
    for root, _dirs, files in os.walk(BROWSERS):
        if "chrome-headless-shell.exe" in files:
            return os.path.join(root, "chrome-headless-shell.exe")
    raise RuntimeError("The bundled browser is not installed (vendor\\browsers is missing).")


def _config(profile):
    out = os.path.join(_workspace(), ".browser")
    os.makedirs(out, exist_ok=True)
    cfg = {
        "browser": {"browserName": "chromium", "userDataDir": profile,
                    "launchOptions": {"executablePath": _headless_shell(), "headless": True}},
        "network": {"blockedOrigins": BLOCKED_ORIGINS},
        "outputDir": out,
        "timeouts": {"action": 8000, "navigation": 45000},
    }
    path = os.path.join(PROFILES, f"pw-{SESSION}.json")
    os.makedirs(PROFILES, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    return path


def _env():
    e = dict(os.environ)
    e["PLAYWRIGHT_BROWSERS_PATH"] = BROWSERS
    e["PLAYWRIGHT_MCP_BLOCKED_ORIGINS"] = ";".join(BLOCKED_ORIGINS)
    if os.name == "nt":
        # Playwright's bundled CLI starts the headless browser through
        # child_process.spawn without windowsHide. Node inherits that option
        # as false, which can briefly show a console window in a desktop app.
        # Preload a tiny wrapper into the CLI process so all child processes
        # created by Playwright hide their console windows.
        shim = os.path.join(PROFILES, "windows-hide.cjs")
        os.makedirs(PROFILES, exist_ok=True)
        if not os.path.exists(shim):
            fd, temporary_shim = tempfile.mkstemp(prefix="windows-hide-", suffix=".cjs", dir=PROFILES)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                    f.write(
                        'const cp = require("node:child_process");\n'
                        'const spawn = cp.spawn;\n'
                        'cp.spawn = function(command, args, options) {\n'
                        '  if (!Array.isArray(args)) { options = args; args = []; }\n'
                        '  const hidden = { ...(options || {}), windowsHide: true };\n'
                        '  if (process.env.LOCALWORK_WINDOWS_HIDE_LOG) require("node:fs").appendFileSync(process.env.LOCALWORK_WINDOWS_HIDE_LOG, JSON.stringify({ command: String(command), windowsHide: hidden.windowsHide }) + "\\n");\n'
                        '  return spawn.call(this, command, args, hidden);\n'
                        '};\n'
                    )
                try:
                    os.replace(temporary_shim, shim)
                except OSError:
                    if not os.path.exists(shim):
                        raise
            finally:
                try:
                    os.remove(temporary_shim)
                except FileNotFoundError:
                    pass
        require_arg = "--require " + json.dumps(shim)
        e["NODE_OPTIONS"] = " ".join(x for x in (e.get("NODE_OPTIONS", ""), require_arg) if x)
    return e


def _run(args, timeout=TIMEOUT):
    r = subprocess.run([NODE, CLI, f"-s={SESSION}", *args], capture_output=True, text=True, timeout=timeout,
                       cwd=_workspace(), env=_env(), creationflags=CREATE_NO_WINDOW, stdin=subprocess.DEVNULL,
                       encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def _ensure_open():
    rc, out = _run(["list"])
    if re.search(rf"- {re.escape(SESSION)}:\s*\n\s*- status: open", out):
        return
    last = ""
    for suffix in ("", f"-{SESSION}"):  # second try: private profile if another chat holds the shared one
        rc, last = _run(["--config", _config(_profile_dir(suffix)), "open"], timeout=120)
        if rc == 0 and "opened" in last:
            return
    raise RuntimeError("Could not start the browser:\n" + last[-1500:])


def _clean_snapshots():
    d = os.path.join(_workspace(), ".browser")
    try:
        for f in os.listdir(d):
            if f.endswith((".yml", ".log")):
                os.remove(os.path.join(d, f))
    except OSError:
        pass


def _inline_snapshots(text):
    """The CLI writes snapshots to files; return their contents inline so the model can read them."""
    def sub(m):
        p = os.path.join(_workspace(), m.group(1).replace("\\", os.sep))
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                body = f.read()
            try:
                os.remove(p)
            except OSError:
                pass
        except OSError:
            return m.group(0)
        if len(body) > 14000:
            body = body[:14000] + "\n[snapshot truncated]"
        return "\n" + body
    return re.sub(r"- \[Snapshot\]\(([^)]+\.yml)\)", sub, text)


def run(args):
    cmd = args.get("command")
    rest = args.get("args") or []
    if isinstance(rest, str):
        rest = shlex.split(rest, posix=False)
    if isinstance(cmd, str) and " " in cmd.strip() and not rest:
        parts = shlex.split(cmd, posix=False)
        cmd, rest = parts[0], parts[1:]
    cmd = (cmd or "").strip().lower()
    rest = [str(a) for a in rest]
    if cmd not in ALLOWED:
        raise ValueError(f"Unknown browser command '{cmd}'. Allowed: {', '.join(sorted(ALLOWED))}")
    if not CLI or not os.path.exists(CLI):
        raise RuntimeError("The bundled browser is not installed.")
    if cmd in NAVIGATE:
        for a in rest:
            if not a.startswith("-"):
                check_url(a)
    if cmd == "close":
        _, out = _run(["close"])
        return out.strip() or "Closed."
    if cmd == "open":
        _ensure_open()
        if rest:
            cmd, rest = "goto", rest[:1]
        else:
            return "Browser is open."
    else:
        _ensure_open()
    rc, out = _run([cmd, *rest])
    out = _inline_snapshots(out).strip()
    _clean_snapshots()
    if cmd in ("goto", "click", "dblclick", "press", "go-back", "go-forward", "reload", "tab-select", "tab-new"):
        # A redirect can land somewhere private; the in-browser block stops its requests, but say so clearly.
        m = re.search(r"Page URL: (\S+)", out)
        if m:
            try:
                check_url(m.group(1))
            except ValueError as e:
                _run(["goto", "about:blank"])
                raise ValueError(str(e) + " The page was closed.")
    if rc != 0:
        raise RuntimeError(out[-3000:] or f"browser exited {rc}")
    return out[-24000:] or "OK"


def shutdown():
    try:
        if CLI and os.path.exists(CLI):
            _run(["close"], timeout=20)
    except Exception:
        pass
