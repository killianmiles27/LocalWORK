"""Offline workspace search regressions; all source documents are generated fixtures."""
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile

SERVER = Path(__file__).resolve().parents[2] / "workbench-mcp" / "server.py"


class LocalSearch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        (self.workspace / "notes").mkdir()
        (self.workspace / "notes/plan.md").write_text("# Plan\nThe zephyr telescope launches tomorrow.\nBudget approval pending.\n", encoding="utf-8")
        (self.workspace / "other.txt").write_text("The zephyr telescope has a mirror.\n", encoding="utf-8")

    def protocol(self, method, params=None):
        request = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
        run = subprocess.run([sys.executable, str(SERVER)], cwd=self.workspace,
                             input=json.dumps(request) + "\n", text=True, capture_output=True,
                             check=True, timeout=30)
        return json.loads(run.stdout)["result"]

    def call(self, name, **args):
        return self.protocol("tools/call", {"name": name, "arguments": args})

    def read(self, name, **args):
        result = self.call(name, **args)
        self.assertFalse(result.get("isError"), result)
        text = result["content"][0]["text"]
        self.assertLessEqual(len(text), 22000)
        return json.loads(text)

    def index(self, **args):
        return self.read("index_workspace", **args)

    def search(self, **args):
        return self.read("search_workspace", **args)

    def test_registration_and_missing_index_refusal(self):
        tools = self.protocol("tools/list")["tools"]
        self.assertTrue({"index_workspace", "search_workspace"}.issubset({t["name"] for t in tools}))
        result = self.call("search_workspace", query="zephyr")
        self.assertTrue(result.get("isError"))
        refusal = json.loads(result["content"][0]["text"])
        self.assertEqual(refusal["error_code"], "search_index_missing")
        self.assertFalse(refusal["write_performed"])
        self.assertIn("index_workspace", refusal["recovery"])
        self.assertFalse((self.workspace / ".localwork").exists())

    def test_index_fts_locations_and_local_storage(self):
        result = self.index()
        self.assertEqual(result["indexed"], 2)
        self.assertEqual(result["index_path"], ".localwork/search.sqlite")
        self.assertTrue((self.workspace / result["index_path"]).is_file())
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["workspace"])
        hits = self.search(query="zephyr telescope", mode="fts")["results"]
        self.assertEqual({h["path"] for h in hits}, {"notes/plan.md", "other.txt"})
        hit = next(h for h in hits if h["path"] == "notes/plan.md")
        self.assertEqual(hit["location"]["line_start"], 1)
        self.assertIn("zephyr", hit["snippet"])
        opened = self.call("read_attachment", **hit["open"])["content"][0]["text"]
        self.assertIn("zephyr telescope", opened)
        with closing(sqlite3.connect(self.workspace / result["index_path"])) as db:
            self.assertEqual(db.execute("select count(*) from chunks where typeof(vector)='blob'").fetchone()[0], 2)

    def test_incremental_edit_delete_and_full_rebuild(self):
        self.index()
        unchanged = self.index()
        self.assertEqual((unchanged["indexed"], unchanged["unchanged"]), (0, 2))
        path = self.workspace / "notes/plan.md"
        path.write_text("The quasar experiment is approved.\n", encoding="utf-8")
        os.utime(path, ns=(path.stat().st_atime_ns, path.stat().st_mtime_ns + 1_000_000_000))
        (self.workspace / "other.txt").unlink()
        edited = self.index()
        self.assertEqual((edited["indexed"], edited["removed"]), (1, 1))
        self.assertEqual(self.search(query="zephyr")["results"], [])
        self.assertEqual(self.search(query="quasar")["results"][0]["path"], "notes/plan.md")
        rebuilt = self.index(full_rebuild=True)
        self.assertEqual((rebuilt["indexed"], rebuilt["unchanged"]), (1, 0))

    def test_incremental_uses_both_mtime_and_size_and_removes_new_binary(self):
        self.index()
        path = self.workspace / "other.txt"
        original = path.stat()
        path.write_text("The zephyr telescope has a sensor.\n", encoding="utf-8")
        self.assertEqual(path.stat().st_size, original.st_size)
        os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns + 1_000_000_000))
        self.assertEqual(self.index()["indexed"], 1)
        self.assertEqual(self.search(query="sensor")["results"][0]["path"], "other.txt")
        original = path.stat()
        path.write_text("The zephyr telescope has a sensor and lens.\n", encoding="utf-8")
        os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))
        self.assertEqual(self.index()["indexed"], 1)
        self.assertEqual(self.search(query="lens")["results"][0]["path"], "other.txt")
        path.write_bytes(b"\x00binary")
        self.assertEqual(self.index()["removed"], 1)
        self.assertEqual(self.search(query="sensor")["results"], [])

    def test_thousand_file_index_and_incremental_search(self):
        folder = self.workspace / "inventory"
        folder.mkdir()
        for i in range(1000):
            (folder / f"record-{i:04}.txt").write_text(f"Inventory record item{i:04} synthetic fixture.\n", encoding="utf-8")
        self.assertEqual(self.index()["indexed"], 1002)
        second = self.index()
        self.assertEqual((second["indexed"], second["unchanged"]), (0, 1002))
        self.assertEqual(self.search(query="item0731")["results"][0]["path"], "inventory/record-0731.txt")

    def test_vector_similarity_and_hybrid_are_deterministic(self):
        self.index()
        # No exact FTS token exists; character n-grams still find the close spelling.
        self.assertEqual(self.search(query="telescopes", mode="fts")["results"], [])
        vector = self.search(query="telescopes", mode="vector", limit=1)
        self.assertEqual(len(vector["results"]), 1)
        self.assertGreater(vector["results"][0]["cosine"], 0)
        self.assertEqual(vector, self.search(query="telescopes", mode="vector", limit=1))
        hybrid = self.search(query="zephyr telescope")
        self.assertEqual(hybrid["mode"], "hybrid")
        self.assertTrue(all("cosine" in hit for hit in hybrid["results"]))

    def test_filter_limit_and_invalid_arguments(self):
        self.index()
        self.assertEqual(len(self.search(query="zephyr", limit=1)["results"]), 1)
        for mode in ("fts", "hybrid", "vector"):
            hits = self.search(query="zephyr", path_filter="notes", mode=mode)["results"]
            self.assertEqual([h["path"] for h in hits], ["notes/plan.md"])
        for args in ({"limit": 0}, {"limit": True}, {"limit": 21}, {"mode": "remote"},
                     {"path_filter": "../outside"}, {"path_filter": "/tmp"}, {"path_filter": "C:\\secret"}, {"query": ""}):
            with self.subTest(args=args):
                self.assertTrue(self.call("search_workspace", **{"query": "zephyr", **args}).get("isError"))
        # Query punctuation is literal input, not SQL or FTS syntax.
        self.assertEqual(self.search(query='" OR * : -', mode="fts")["results"], [])

    def test_skips_binary_hidden_oversized_and_corrupt_documents(self):
        (self.workspace / "binary.txt").write_bytes(b"hello\x00private")
        (self.workspace / "image.bin").write_bytes(b"\xff\x00")
        (self.workspace / ".hidden").mkdir()
        (self.workspace / ".hidden/secret.md").write_text("zephyr")
        (self.workspace / "bad.docx").write_bytes(b"not a zip")
        with (self.workspace / "large.log").open("wb") as stream:
            stream.truncate(9 * 1024 * 1024)
        report = self.index()
        reasons = {s["path"]: s["reason"] for s in report["skipped"]}
        self.assertIn("binary", reasons["binary.txt"])
        self.assertIn("unsupported", reasons["image.bin"])
        self.assertIn("hidden", reasons[".hidden"])
        self.assertIn("size", reasons["large.log"])
        self.assertIn("extraction", reasons["bad.docx"])
        self.assertEqual(report["indexed"], 2)
        second = self.index()
        self.assertIn(".localwork", {s["path"] for s in second["skipped"]})

    def test_index_rejects_symlink_storage_and_external_sources(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "secret.md").write_text("classified zephyr")
        try:
            (self.workspace / "external.md").symlink_to(outside / "secret.md")
            (self.workspace / ".localwork").symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symlinks unavailable: {exc}")
        self.assertTrue(self.call("index_workspace").get("isError"))
        self.assertFalse((outside / "search.sqlite").exists())
        (self.workspace / ".localwork").unlink()
        report = self.index()
        self.assertIn("external.md", {s["path"] for s in report["skipped"]})
        self.assertNotIn("external.md", {h["path"] for h in self.search(query="zephyr")["results"]})
        # Replacing a previously indexed source with an external link must not leak cached text.
        (self.workspace / "other.txt").unlink()
        (self.workspace / "other.txt").symlink_to(outside / "secret.md")
        self.assertNotIn("other.txt", {h["path"] for h in self.search(query="zephyr")["results"]})

    def test_database_symlink_refused_before_write(self):
        (self.workspace / ".localwork").mkdir()
        outside = self.root / "keep.sqlite"
        outside.write_bytes(b"keep")
        try:
            (self.workspace / ".localwork/search.sqlite").symlink_to(outside)
        except OSError as exc:
            self.skipTest(f"symlinks unavailable: {exc}")
        self.assertTrue(self.call("index_workspace").get("isError"))
        self.assertEqual(outside.read_bytes(), b"keep")

    def test_html_and_office_extractors(self):
        (self.workspace / "page.html").write_text('<p>Heliotrope &amp; sunlight</p><script>forbiddenword</script>', encoding="utf-8")
        (self.workspace / "data.csv").write_text("Name,Value\nHeliotrope,7\n", encoding="utf-8")
        (self.workspace / "data.json").write_text('{"plant":"Heliotrope"}', encoding="utf-8")
        (self.workspace / "event.log").write_text("Heliotrope logged", encoding="utf-8")
        fixtures = {
            "brief.docx": {"word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Heliotrope briefing</w:t></w:r></w:p></w:body></w:document>'},
            "slides.pptx": {"ppt/slides/slide1.xml": '<a:root xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:t>Heliotrope slide</a:t></a:p></a:root>'},
            "book.xlsx": {"xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Heliotrope cell</t></is></c></row></sheetData></worksheet>'},
        }
        for filename, members in fixtures.items():
            with zipfile.ZipFile(self.workspace / filename, "w") as archive:
                for name, xml in members.items():
                    archive.writestr(name, xml)
        report = self.index()
        self.assertEqual(report["indexed"], 9, report)
        hits = self.search(query="Heliotrope", mode="fts", limit=20)["results"]
        self.assertEqual(len(hits), 7)
        self.assertEqual(self.search(query="forbiddenword")["results"], [])
        for hit in hits:
            self.assertNotIn("<p>", hit["snippet"])
            opened = self.call("read_attachment", **hit["open"])["content"][0]["text"]
            self.assertIn("Heliotrope", opened)

    @unittest.skipUnless(importlib.util.find_spec("pypdf"), "pypdf is not installed")
    def test_pdf_page_reference_and_open(self):
        # A minimal real text PDF, with a generated xref table (no external fixture/library).
        objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
                   b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
                   b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
        content = b'BT /F1 12 Tf 72 720 Td (Heliotrope PDF) Tj ET'
        objects.append(b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream')
        pdf = b'%PDF-1.4\n'
        offsets = [0]
        for i, obj in enumerate(objects, 1):
            offsets.append(len(pdf))
            pdf += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
        xref = len(pdf)
        pdf += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(f'{off:010d} 00000 n \n'.encode() for off in offsets[1:])
        pdf += f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
        (self.workspace / "paper.pdf").write_bytes(pdf)
        report = self.index()
        self.assertEqual(report["indexed"], 3, report)
        hit = self.search(query="Heliotrope", mode="fts")["results"][0]
        self.assertEqual(hit["path"], "paper.pdf")
        self.assertEqual(hit["location"]["page"], 1)
        self.assertIn("Heliotrope PDF", self.call("read_attachment", **hit["open"])["content"][0]["text"])

    def test_corrupt_xml_is_skipped_and_large_skip_report_is_valid_json(self):
        with zipfile.ZipFile(self.workspace / "broken.docx", "w") as archive:
            archive.writestr("word/document.xml", "<unclosed>")
        for i in range(100):
            (self.workspace / f"binary-{i}.bin").write_bytes(b"\x00")
        report = self.index()
        self.assertEqual(report["indexed"], 2)
        self.assertGreaterEqual(report["skipped_count"], 101)
        self.assertTrue(report["skipped_truncated"])

    def test_chunk_line_end_matches_source_and_stable_rebuild(self):
        text = "".join(f"Line {i:02} " + "a " * 40 + "\n" for i in range(1, 51))
        (self.workspace / "lines.md").write_text(text, encoding="utf-8")
        self.index()
        hits = self.search(query="Line", path_filter="lines.md", mode="fts", limit=20)["results"]
        self.assertGreater(len(hits), 1)
        for hit in hits:
            part = text[hit["open"]["start"]:hit["open"]["start"] + hit["open"]["max_chars"]]
            self.assertEqual(int(part.splitlines()[-1].split()[1]), hit["location"]["line_end"])
        self.index(full_rebuild=True)
        self.assertEqual(hits, self.search(query="Line", path_filter="lines.md", mode="fts", limit=20)["results"])

    def test_long_lines_have_exact_offsets_and_bounded_output(self):
        (self.workspace / "long.txt").write_text("x" * 2500 + " distinctivepassage " + "y" * 2500, encoding="utf-8")
        self.index()
        hit = self.search(query="distinctivepassage", mode="fts")["results"][0]
        self.assertGreater(hit["open"]["start"], 0)
        opened = self.call("read_attachment", **hit["open"])["content"][0]["text"]
        self.assertIn("distinctivepassage", opened)
        self.assertEqual(hit["location"]["line_start"], 1)


if __name__ == "__main__":
    unittest.main()
