"""read_attachment: turns an attached file into text, readable in ranges. Stdlib plus pypdf (already bundled in libs)."""
import csv, io, os, re, sys, zipfile
from xml.etree import ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "libs"))

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
IMG = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")


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
    sheets = sorted((n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)), key=lambda n: int(re.findall(r"\d+", n)[0]))
    out = []
    for i, n in enumerate(sheets, 1):
        out.append(f"--- Sheet {i} ---")
        for row in ET.fromstring(z.read(n)).iter(S + "row"):
            cells = []
            for c in row.iter(S + "c"):
                v = c.find(S + "v")
                f = c.find(S + "f")
                val = "" if v is None else (shared[int(v.text)] if c.get("t") == "s" and v.text else (v.text or ""))
                if f is not None and f.text:
                    val = f"{val} (={f.text})"
                cells.append(f"{c.get('r')}={val}")
            out.append(" | ".join(cells))
    return "\n".join(out)


def _pdf(path):
    from pypdf import PdfReader
    rd = PdfReader(path)
    pages = [(p.extract_text() or "").strip() for p in rd.pages]
    if not any(pages):
        return "(This PDF has no text layer, so it is probably a scan. I can only read text PDFs.)"
    return "\n\n".join(f"--- Page {i} ---\n{t}" for i, t in enumerate(pages, 1))


def read_attachment(path, start=0, max_chars=12000):
    root = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(root, str(path)))
    if full != root and not full.startswith(root + os.sep):
        raise ValueError("path must be inside the workspace")
    if not os.path.isfile(full):
        raise ValueError(f"no such file: {path}")
    ext = os.path.splitext(full)[1].lower()
    if ext in IMG:
        return f"{path} is an image ({os.path.getsize(full)} bytes). I cannot see images in this setup; ask the user to describe it or attach text."
    if ext == ".pdf":
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
