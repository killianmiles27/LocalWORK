"""read_attachment: turns an attached file into text, readable in ranges. Stdlib plus pypdf (already bundled in libs)."""
import csv, io, os, posixpath, re, shutil, subprocess, sys, tempfile, time, zipfile
from xml.etree import ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "libs"))

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
IMG = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
OCR_MAX_PAGES = 10
OCR_TIME_LIMIT = 60
OCR_LABEL = "[Machine-recognised text; OCR may contain errors. Check the original.]"


def _docx(z):
    root = ET.fromstring(z.read("word/document.xml"))
    out = []
    for p in root.iter(W + "p"):
        t = "".join(x.text or "" for x in p.iter(W + "t"))
        if t.strip():
            out.append(t)
    return "\n".join(out)


def _pptx(z):
    names = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=lambda n: int(re.findall(r"\d+", n)[0]))
    out = []
    for i, n in enumerate(names, 1):
        root = ET.fromstring(z.read(n))
        paras = ["".join(x.text or "" for x in p.iter(A + "t")) for p in root.iter(A + "p")]
        out.append(f"--- Slide {i} ---\n" + "\n".join(p for p in paras if p.strip()))
    return "\n\n".join(out)


def _xlsx(z):
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(S + "si"):
            shared.append("".join(t.text or "" for t in si.iter(S + "t")))
    names = set(z.namelist())
    sheets = []
    if "xl/workbook.xml" in names and "xl/_rels/workbook.xml.rels" in names:
        rels_root = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels_root.iter(REL + "Relationship")}
        workbook = ET.fromstring(z.read("xl/workbook.xml"))
        for sheet in workbook.iter(S + "sheet"):
            target = targets.get(sheet.get(R + "id"))
            if not target:
                continue
            path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target))
            if path in names:
                sheets.append((sheet.get("name") or path, path))
    if not sheets:
        sheets = [(f"Sheet {i}", n) for i, n in enumerate(
            sorted((n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)),
                   key=lambda n: int(re.findall(r"\d+", n)[0])), 1)]
    out = []
    for sheet_name, n in sheets:
        out.append(f"--- Sheet: {sheet_name} ---")
        for row in ET.fromstring(z.read(n)).iter(S + "row"):
            cells = []
            for c in row.iter(S + "c"):
                v = c.find(S + "v")
                f = c.find(S + "f")
                val = "" if v is None else (shared[int(v.text)] if c.get("t") == "s" and v.text else (v.text or ""))
                if c.get("t") == "inlineStr":
                    inline = c.find(S + "is")
                    val = "" if inline is None else "".join(t.text or "" for t in inline.iter(S + "t"))
                if f is not None and f.text:
                    val = f"{val} (={f.text})"
                cells.append(f"{c.get('r')}={val}")
            out.append(" | ".join(cells))
    return "\n".join(out)


def _ocr_binary(name):
    env_name = "LOCALWORK_" + name.upper()
    override = os.environ.get(env_name)
    if override:
        return shutil.which(override)
    executable = name + (".exe" if os.name == "nt" else "")
    vendor = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor", name, executable)
    if os.path.isfile(vendor) and os.access(vendor, os.X_OK):
        return vendor
    return shutil.which(executable)


def _missing_ocr(name):
    package = "Tesseract OCR" if name == "tesseract" else "Poppler (pdftoppm)"
    return f"OCR unavailable: {name} not found. Install {package} and add it to PATH, or set LOCALWORK_{name.upper()} to its executable."


def _ocr_run(args, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError
    try:
        result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                stdin=subprocess.DEVNULL, timeout=remaining,
                                creationflags=0x08000000 if os.name == "nt" else 0)
    except subprocess.TimeoutExpired:
        raise TimeoutError from None
    except OSError as exc:
        raise RuntimeError(f"{os.path.basename(args[0])} could not start: {exc}") from exc
    if result.returncode:
        detail = (result.stderr or "").strip()[:500]
        raise RuntimeError(f"{os.path.basename(args[0])} failed (exit {result.returncode})" + (f": {detail}" if detail else ""))
    return result.stdout or ""


def _recognise(image, tesseract, deadline):
    language = os.environ.get("LOCALWORK_OCR_LANG") or "eng"
    if not re.fullmatch(r"[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*", language):
        raise RuntimeError("Invalid LOCALWORK_OCR_LANG; use Tesseract language codes such as eng or eng+fra.")
    text = _ocr_run([tesseract, image, "stdout", "-l", language], deadline).strip()
    return OCR_LABEL + "\n" + (text or "(No text recognised; check the original image.)")


def _pdf(path):
    from pypdf import PdfReader
    rd = PdfReader(path)
    pages = [(p.extract_text() or "").strip() for p in rd.pages]
    if all(len(re.sub(r"\s", "", text)) > 2 for text in pages):
        return "\n\n".join(f"--- Page {i} ---\n{t}" for i, t in enumerate(pages, 1))

    tesseract, pdftoppm = _ocr_binary("tesseract"), _ocr_binary("pdftoppm")
    missing = [_missing_ocr(name) for name, binary in (("tesseract", tesseract), ("pdftoppm", pdftoppm)) if not binary]
    deadline = time.monotonic() + OCR_TIME_LIMIT
    attempted = 0
    timed_out = False
    with tempfile.TemporaryDirectory(prefix="localwork-ocr-") as directory:
        for i, text in enumerate(pages, 1):
            if len(re.sub(r"\s", "", text)) > 2:
                continue
            original = f"Text layer: {text}\n" if text else ""
            if missing:
                pages[i - 1] = original + " ".join(missing)
            elif timed_out:
                pages[i - 1] = original + "OCR skipped: total time limit reached."
            elif attempted >= OCR_MAX_PAGES:
                pages[i - 1] = original + f"OCR skipped: page limit of {OCR_MAX_PAGES} per call reached."
            else:
                attempted += 1
                prefix = os.path.join(directory, f"page-{i}")
                try:
                    _ocr_run([pdftoppm, "-f", str(i), "-l", str(i), "-singlefile", "-r", "150", "-png", path, prefix], deadline)
                    pages[i - 1] = original + _recognise(prefix + ".png", tesseract, deadline)
                except TimeoutError:
                    timed_out = True
                    pages[i - 1] = original + "OCR stopped: total time limit reached."
                except RuntimeError as exc:
                    pages[i - 1] = original + f"OCR failed: {exc}"
    return "\n\n".join(f"--- Page {i} ---\n{t}" for i, t in enumerate(pages, 1))


def workspace_file(path):
    """Resolve an existing file using the attachment workspace boundary."""
    root = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(root, str(path)))
    if full != root and not full.startswith(root + os.sep):
        raise ValueError("path must be inside the workspace")
    if not os.path.isfile(full):
        raise ValueError(f"no such file: {path}")
    return full


def read_attachment(path, start=0, max_chars=12000):
    full = workspace_file(path)
    ext = os.path.splitext(full)[1].lower()
    if ext in IMG:
        tesseract = _ocr_binary("tesseract")
        if not tesseract:
            text = f"{path} is an image ({os.path.getsize(full)} bytes). I cannot see images in this setup; ask the user to describe it or attach text. " + _missing_ocr("tesseract")
        else:
            try:
                text = _recognise(full, tesseract, time.monotonic() + OCR_TIME_LIMIT)
            except TimeoutError:
                text = "OCR stopped: total time limit reached."
            except RuntimeError as exc:
                text = f"OCR failed: {exc}"
    elif ext == ".pdf":
        text = _pdf(full)
    elif ext in (".docx", ".pptx", ".xlsx"):
        with zipfile.ZipFile(full) as z:
            text = {".docx": _docx, ".pptx": _pptx, ".xlsx": _xlsx}[ext](z)
    else:
        raw = open(full, "rb").read()
        text = raw.decode("utf-8", errors="replace")
        if ext == ".html" or ext == ".htm":
            text = re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(script|style).*?</\1>", "", text))
            text = re.sub(r"[ \t]+", " ", text)
    start, max_chars = int(start), int(max_chars)
    cut = text[start:start + max_chars]
    total = len(text)
    note = f"\n\n[showing characters {start}-{start + len(cut)} of {total}; call again with start={start + len(cut)} for more]" if start + len(cut) < total else ""
    return f"File: {path} ({total} characters)\n\n{cut}{note}"
