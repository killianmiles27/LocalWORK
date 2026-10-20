"""Focused XLSX attachment extraction regressions."""
import importlib.util
import io
from pathlib import Path
import unittest
import zipfile

ATTACHMENTS = Path(__file__).resolve().parents[2] / "workbench-mcp" / "attachments.py"
SPEC = importlib.util.spec_from_file_location("workbench_attachments_xlsx", ATTACHMENTS)
attachments = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(attachments)


class XlsxAttachment(unittest.TestCase):
    def test_inline_rich_text_and_workbook_sheet_order_and_names(self):
        workbook = b'''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Second Tab" sheetId="1" r:id="rId2"/><sheet name="First Tab" sheetId="2" r:id="rId1"/></sheets></workbook>'''
        relationships = b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'''
        first = b'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>Monthly </t></r><r><t>income</t></r></is></c><c r="B1" t="inlineStr"><is><t>2011-01</t></is></c></row></sheetData></worksheet>'''
        second = b'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Summary</t></is></c></row></sheetData></worksheet>'''
        with io.BytesIO() as buffer:
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("xl/workbook.xml", workbook)
                archive.writestr("xl/_rels/workbook.xml.rels", relationships)
                archive.writestr("xl/worksheets/sheet1.xml", first)
                archive.writestr("xl/worksheets/sheet2.xml", second)
            buffer.seek(0)
            with zipfile.ZipFile(buffer) as archive:
                result = attachments._xlsx(archive)

        self.assertLess(result.index("--- Sheet: Second Tab ---"), result.index("--- Sheet: First Tab ---"))
        self.assertIn("A1=Monthly income | B1=2011-01", result)
        self.assertIn("--- Sheet: Second Tab ---\nA1=Summary", result)
        self.assertIn("--- Sheet: First Tab ---\nA1=Monthly income", result)


if __name__ == "__main__":
    unittest.main()
