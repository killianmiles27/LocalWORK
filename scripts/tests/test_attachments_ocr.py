"""Local attachment OCR, with external tools replaced at the process boundary."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import pypdf

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("workbench_attachments_ocr", ROOT / "workbench-mcp" / "attachments.py")
attachments = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(attachments)


class Page:
    def __init__(self, text):
        self.text = text

    def extract_text(self):
        return self.text


class AttachmentOCR(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old_cwd = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.old_cwd)
        (self.root / "input.pdf").write_bytes(b"pdf")
        (self.root / "input.png").write_bytes(b"image")
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def pdf(self, pages):
        return patch.object(pypdf, "PdfReader", return_value=type("Reader", (), {"pages": [Page(p) for p in pages]})())

    def tools(self):
        return patch.object(shutil, "which", side_effect=lambda name: "/tools/" + name)

    def test_text_pdf_is_unchanged_and_never_starts_ocr(self):
        with self.pdf(["First page", "Another page"]), patch.object(subprocess, "run") as run:
            result = attachments.read_attachment("input.pdf")
        self.assertIn("--- Page 1 ---\nFirst page\n\n--- Page 2 ---\nAnother page", result)
        run.assert_not_called()

    def test_scanned_pages_only_are_rendered_and_recognised(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if Path(args[0]).name.removesuffix(".exe") == "pdftoppm":
                Path(args[-1] + ".png").write_bytes(b"render")
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 0, "Scanned words\n", "")
        with self.pdf(["usable text", " x ", ""]), self.tools(), patch.object(subprocess, "run", side_effect=run):
            result = attachments.read_attachment("input.pdf")
        self.assertIn("--- Page 1 ---\nusable text", result)
        self.assertIn("--- Page 2 ---", result)
        self.assertIn("machine-recogn", result.lower())
        self.assertEqual(result.count("Scanned words"), 2)
        renders = [c for c in calls if Path(c[0]).name.removesuffix(".exe") == "pdftoppm"]
        self.assertEqual([c[c.index("-f") + 1] for c in renders], ["2", "3"])
        self.assertTrue(all(not Path(c[-1] + ".png").exists() for c in renders))
        self.assertTrue(all(not Path(c[-1]).parent.exists() for c in renders))

    def test_page_limit_marks_skipped_pages(self):
        def run(args, **kwargs):
            if Path(args[0]).name.removesuffix(".exe") == "pdftoppm":
                Path(args[-1] + ".png").write_bytes(b"render")
            return subprocess.CompletedProcess(args, 0, "words", "")
        with self.pdf([""] * 3), self.tools(), patch.object(attachments, "OCR_MAX_PAGES", 2, create=True), patch.object(subprocess, "run", side_effect=run):
            result = attachments.read_attachment("input.pdf")
        self.assertEqual(result.lower().count("machine-recogn"), 2)
        self.assertIn("--- Page 3 ---", result)
        self.assertIn("page limit", result.lower())

    def test_timeout_is_reported_and_temp_files_cleaned(self):
        paths = []
        def run(args, **kwargs):
            if Path(args[0]).name.removesuffix(".exe") == "pdftoppm":
                paths.append(Path(args[-1]).parent)
                Path(args[-1] + ".png").write_bytes(b"render")
                return subprocess.CompletedProcess(args, 0, "", "")
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])
        with self.pdf([""]), self.tools(), patch.object(subprocess, "run", side_effect=run):
            result = attachments.read_attachment("input.pdf")
        self.assertIn("time limit", result.lower())
        self.assertTrue(paths)
        self.assertTrue(all(not p.exists() for p in paths))

    def test_missing_tesseract_is_actionable(self):
        with patch.object(shutil, "which", return_value=None):
            result = attachments.read_attachment("input.png")
        self.assertIn("tesseract", result.lower())
        self.assertIn("install", result.lower())
        self.assertIn("cannot see images", result.lower())

    def test_nonzero_tesseract_is_not_mistaken_for_ocr_text(self):
        with self.tools(), patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "unreadable")):
            result = attachments.read_attachment("input.png")
        self.assertIn("tesseract", result.lower())
        self.assertIn("failed", result.lower())
        self.assertNotIn("machine-recognised text", result.lower())

    def test_missing_pdftoppm_keeps_text_layer_and_reports_installation(self):
        with self.pdf(["OK", "readable page"]), patch.object(shutil, "which", side_effect=lambda name: "/tools/tesseract" if name.removesuffix(".exe") == "tesseract" else None), patch.object(subprocess, "run") as run:
            result = attachments.read_attachment("input.pdf")
        self.assertIn("Text layer: OK", result)
        self.assertIn("pdftoppm", result)
        self.assertIn("Install Poppler", result)
        self.assertIn("--- Page 2 ---\nreadable page", result)
        run.assert_not_called()

    def test_binary_discovery_prefers_override_then_vendor_then_path(self):
        vendor = self.root / "vendor" / "tesseract" / ("tesseract.exe" if os.name == "nt" else "tesseract")
        vendor.parent.mkdir(parents=True)
        vendor.write_bytes(b"fake")
        vendor.chmod(0o755)
        script = self.root / "workbench-mcp" / "attachments.py"
        with patch.object(attachments, "__file__", str(script)), patch.object(shutil, "which", side_effect=lambda name: "/path/" + name):
            with patch.dict(os.environ, {"LOCALWORK_TESSERACT": "custom"}):
                self.assertEqual(attachments._ocr_binary("tesseract"), "/path/custom")
            self.assertEqual(attachments._ocr_binary("tesseract"), str(vendor))
            vendor.unlink()
            self.assertEqual(attachments._ocr_binary("tesseract"), "/path/" + vendor.name)

    def test_language_override_and_deadline_are_passed_to_children(self):
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            if Path(args[0]).name.removesuffix(".exe") == "pdftoppm":
                Path(args[-1] + ".png").write_bytes(b"render")
            return subprocess.CompletedProcess(args, 0, "Recognised", "")
        with self.pdf([""]), self.tools(), patch.dict(os.environ, {"LOCALWORK_OCR_LANG": "eng+fra"}), patch.object(attachments.time, "monotonic", side_effect=[100, 105, 112]), patch.object(subprocess, "run", side_effect=run):
            result = attachments.read_attachment("input.pdf")
        self.assertIn("Recognised", result)
        self.assertEqual([c[1]["timeout"] for c in calls], [55, 48])
        self.assertEqual(calls[1][0][-2:], ["-l", "eng+fra"])

    def test_elapsed_deadline_skips_all_remaining_sparse_pages(self):
        with self.pdf(["", ""]), self.tools(), patch.object(attachments.time, "monotonic", side_effect=[0, 61]), patch.object(subprocess, "run") as run:
            result = attachments.read_attachment("input.pdf")
        self.assertEqual(result.lower().count("time limit"), 2)
        run.assert_not_called()

    def test_invalid_override_does_not_silently_use_path(self):
        with patch.dict(os.environ, {"LOCALWORK_TESSERACT": "/missing/tesseract"}), patch.object(shutil, "which", return_value=None), patch.object(subprocess, "run") as run:
            result = attachments.read_attachment("input.png")
        self.assertIn("LOCALWORK_TESSERACT", result)
        self.assertIn("not found", result)
        run.assert_not_called()

    def test_image_outside_workspace_is_refused(self):
        with tempfile.TemporaryDirectory() as other:
            outside = Path(other) / "outside.png"
            outside.write_bytes(b"image")
            with self.assertRaisesRegex(ValueError, "inside the workspace"):
                attachments.read_attachment(str(outside))


class RealOCR(unittest.TestCase):
    @unittest.skipUnless(all(shutil.which(x) for x in ("tesseract", "pdftoppm", "convert")), "tesseract, pdftoppm and ImageMagick convert are required")
    def test_real_image_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "sample.png"
            version = subprocess.run(["convert", "-version"], capture_output=True, text=True)
            if "ImageMagick" not in version.stdout:
                self.skipTest("convert is not ImageMagick")
            fonts = subprocess.run(["convert", "-list", "font"], capture_output=True, text=True, check=True)
            available = [line.split(":", 1)[1].strip() for line in fonts.stdout.splitlines() if line.strip().startswith("Font:")]
            if not available:
                self.skipTest("ImageMagick has no available fonts")
            command = ["convert", "-background", "white", "-fill", "black", "-font", available[0], "-pointsize", "48", "label:LOCAL OCR SAMPLE", str(image)]
            subprocess.run(command, capture_output=True, text=True, check=True)
            old_cwd = os.getcwd()
            try:
                os.chdir(directory)
                with patch.dict(os.environ, {"LOCALWORK_TESSERACT": "", "LOCALWORK_PDFTOPPM": "", "LOCALWORK_OCR_LANG": ""}):
                    result = attachments.read_attachment("sample.png")
            finally:
                os.chdir(old_cwd)
            self.assertIn("LOCAL OCR SAMPLE", result.upper())
            self.assertIn("machine-recogn", result.lower())


if __name__ == "__main__":
    unittest.main()
