"""Regression tests for bounded tabular inspection, aggregation and comparison."""
import importlib.util
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[2] / "workbench-mcp" / "tabular.py"
SPEC = importlib.util.spec_from_file_location("workbench_tabular", MODULE)
tabular = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tabular)


def make_xlsx(path):
    workbook = b'''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Lab Results" sheetId="1" r:id="rId2"/><sheet name="Notes" sheetId="2" r:id="rId1"/></sheets></workbook>'''
    rels = b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'''
    shared = b'''<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>sample </t></r><r><t>id</t></r></si><si><t>reading</t></si><si><t>when</t></si></sst>'''
    sheet = b'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>empty formula</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><r><t>control </t></r><r><t>A</t></r></is></c><c r="B2"><v>4</v></c><c r="C2" t="inlineStr"><is><t>2025-01-03</t></is></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>control A</t></is></c><c r="B3"><f>2+3</f><v>5</v></c><c r="C3"><v>45689</v></c><c r="D3"><f/></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>blank</t></is></c><c r="C4" t="e"><v>#N/A</v></c><c r="D4"/></row>
</sheetData></worksheet>'''
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        archive.writestr("xl/sharedStrings.xml", shared)
        archive.writestr("xl/worksheets/sheet1.xml", b"<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData/></worksheet>")
        archive.writestr("xl/worksheets/sheet2.xml", sheet)


def make_1904_xlsx(path):
    workbook = b'''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>'''
    rels = b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'''
    sheet = b'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>when</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2"><v>0</v></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>'''
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)


def make_formula_xlsx(path):
    workbook = b'''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Actual" sheetId="1" r:id="rId1"/></sheets></workbook>'''
    rels = b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'''
    sheet = b'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2"><f>2+3</f><v>5</v></c></row></sheetData></worksheet>'''
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)


def make_wide_xlsx(path):
    workbook = b'''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Wide" sheetId="1" r:id="rId1"/></sheets></workbook>'''
    rels = b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'''
    sheet = b'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="XFE1" t="inlineStr"><is><t>too wide</t></is></c></row></sheetData></worksheet>'''
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)


class TabularTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = os.getcwd()
        os.chdir(self.temp.name)

    def tearDown(self):
        os.chdir(self.old)
        self.temp.cleanup()

    def test_csv_inventory_inspect_aggregate_and_compare(self):
        Path("stock.csv").write_text("item,zone,units\nbolts,A,2\nbolts,A,3\nnuts,B,4\n", encoding="utf-8")
        result = tabular.handle({"action": "inspect", "path": "stock.csv"})
        self.assertEqual(result["rows"], 3)
        self.assertEqual(result["column_summary"]["units"]["numeric"]["sum"], 9)
        counted = tabular.handle({"action": "aggregate", "path": "stock.csv", "group_by": [],
                                  "measures": [{"op": "count", "as": "rows"}]})
        self.assertEqual(counted["preview"], [{"rows": 3}])
        grouped = tabular.handle({"action": "aggregate", "path": "stock.csv", "group_by": ["item", "zone"],
                                  "measures": [{"column": "units", "op": "sum", "as": "units"}]})
        self.assertTrue(grouped["dataset_path"].startswith(".localwork-data/"))
        saved = json.loads(Path(grouped["dataset_path"]).read_text(encoding="utf-8"))
        self.assertEqual(len(saved["rows"]), 2)
        Path("expected.csv").write_text("item,zone,units\nbolts,A,5\nnuts,B,4\n", encoding="utf-8")
        compared = tabular.handle({"action": "compare", "dataset_path": grouped["dataset_path"], "actual_path": "expected.csv",
                                   "keys": ["item", "zone"], "columns": ["units"]})
        self.assertTrue(compared["equal"])
        Path("evaluated.json").write_text(json.dumps({"columns": ["item", "zone", "units"],
                                                         "rows": [["bolts", "A", 5], ["nuts", "B", 4]],
                                                         "provenance": {"source": "stock.csv", "sha256": tabular._sha(Path("stock.csv").resolve())}}), encoding="utf-8")
        read_back = tabular.handle({"action": "read", "path": "evaluated.json", "limit": 1})
        self.assertEqual(read_back["rows"], [["bolts", "A", 5]])
        compared_json = tabular.handle({"action": "compare", "dataset_path": grouped["dataset_path"], "actual_path": "evaluated.json",
                                        "keys": ["item", "zone"], "columns": ["units"]})
        self.assertTrue(compared_json["equal"])
        Path("evaluated-source.csv").write_text("id,value\na,1\n", encoding="utf-8")
        Path("evaluated.json").write_text(json.dumps({"columns": ["item", "zone", "units"],
                                                         "rows": [["bolts", "A", 5], ["nuts", "B", 4]],
                                                         "provenance": {"source": "evaluated-source.csv", "sha256": tabular._sha(Path("evaluated-source.csv").resolve())}}), encoding="utf-8")
        Path("evaluated-source.csv").write_text("id,value\na,2\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "JSON dataset source changed"):
            tabular.handle({"action": "compare", "dataset_path": grouped["dataset_path"], "actual_path": "evaluated.json",
                            "keys": ["item", "zone"], "columns": ["units"]})
        Path("original.csv").write_text("category,units\npart,2\n", encoding="utf-8")
        Path("evaluated-chain.json").write_text(json.dumps({"columns": ["category", "units"], "rows": [["part", 2]],
                                                               "provenance": {"source": "original.csv", "sha256": tabular._sha(Path("original.csv").resolve())}}), encoding="utf-8")
        chain_aggregate = tabular.handle({"action": "aggregate", "path": "evaluated-chain.json", "group_by": ["category"],
                                          "measures": [{"column": "units", "op": "sum", "as": "units"}]})
        Path("independent-actual.csv").write_text("category,units\npart,2\n", encoding="utf-8")
        Path("original.csv").write_text("category,units\npart,99\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "JSON dataset source changed"):
            tabular.handle({"action": "compare", "dataset_path": chain_aggregate["dataset_path"], "actual_path": "independent-actual.csv",
                            "keys": ["category"], "columns": ["units"]})

    def test_xlsx_relationship_order_rich_strings_formula_cache_and_dates(self):
        make_xlsx("lab.xlsx")
        inspected = tabular.handle({"action": "inspect", "path": "lab.xlsx", "sheet": "Lab Results"})
        self.assertEqual(inspected["columns"], ["sample id", "reading", "when", "empty formula"])
        self.assertEqual(inspected["sheet_names"], ["Lab Results", "Notes"])
        self.assertEqual(inspected["sample"][0]["sample id"], "control A")
        read = tabular.handle({"action": "read", "path": "lab.xlsx", "sheet": "Lab Results", "range": "B3:B4"})
        self.assertEqual(read["rows"][0][0]["formula"], "2+3")
        self.assertEqual(read["rows"][0][0]["cached_value"], 5)
        blank = tabular.handle({"action": "read", "path": "lab.xlsx", "sheet": "Lab Results", "range": "D4:D4"})
        self.assertIsNone(blank["rows"][0][0]["value"])
        with self.assertRaisesRegex(ValueError, "contains a formula"):
            tabular.handle({"action": "aggregate", "path": "lab.xlsx", "sheet": "Lab Results", "group_by": [],
                            "measures": [{"column": "reading", "op": "sum"}]})
        empty_formula = tabular.handle({"action": "read", "path": "lab.xlsx", "sheet": "Lab Results", "range": "D3:D3"})
        self.assertEqual(empty_formula["rows"][0][0]["formula"], "")
        self.assertIsNone(empty_formula["rows"][0][0]["cached_value"])
        with self.assertRaisesRegex(ValueError, "contains a formula"):
            tabular.handle({"action": "aggregate", "path": "lab.xlsx", "sheet": "Lab Results", "group_by": [],
                            "measures": [{"column": "empty formula", "op": "sum"}]})
        with self.assertRaisesRegex(ValueError, "missing value"):
            tabular.handle({"action": "aggregate", "path": "lab.xlsx", "sheet": "Lab Results", "group_by": [],
                            "measures": [{"column": "empty formula", "op": "sum"}], "allow_cached_formulas": True})
        with self.assertRaisesRegex(ValueError, "unknown worksheet"):
            tabular.handle({"action": "inspect", "path": "lab.xlsx", "sheet": "Missing"})
        # A clean sheet demonstrates that date interpretation is explicit.
        Path("clean.csv").write_text("when,reading\n2025-01-03,4\n2025-06-18,5\n", encoding="utf-8")
        grouped = tabular.handle({"action": "aggregate", "path": "clean.csv", "group_by": [{"column": "when", "transform": "year"}],
                                  "measures": [{"column": "reading", "op": "sum", "as": "total"}]})
        self.assertEqual(grouped["preview"], [{"when_year": 2025, "total": 9}])

    def test_ambiguous_text_dates_escape_headers_and_stale_source_are_rejected(self):
        Path("dates.csv").write_text("month,value\n03/04/2025,2\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "date_format"):
            tabular.handle({"action": "aggregate", "path": "dates.csv", "group_by": [{"column": "month", "transform": "month"}],
                            "measures": [{"column": "value", "op": "sum"}]})
        Path("serial.csv").write_text("serial,value\n45689,2\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "date_format"):
            tabular.handle({"action": "aggregate", "path": "serial.csv", "group_by": [{"column": "serial", "transform": "year"}],
                            "measures": [{"column": "value", "op": "sum"}]})
        with self.assertRaisesRegex(ValueError, "inside the workspace"):
            tabular.handle({"action": "inspect", "path": "../outside.csv"})
        with self.assertRaisesRegex(ValueError, "alternate data streams"):
            tabular.handle({"action": "inspect", "path": "dates.csv:stream.csv"})
        result = tabular.handle({"action": "aggregate", "path": "dates.csv", "group_by": [], "measures": [{"column": "value", "op": "sum"}]})
        Path("dates.csv").write_text("month,value\n03/04/2025,999\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "source changed"):
            tabular.handle({"action": "compare", "dataset_path": result["dataset_path"], "actual_path": "dates.csv",
                            "keys": ["month"], "columns": ["sum_value"]})

    def test_ranges_duplicates_1904_epoch_key_comparison_and_mismatch(self):
        Path("dup.csv").write_text("id,id\n1,2\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate column"):
            tabular.handle({"action": "inspect", "path": "dup.csv"})
        Path("wide.csv").write_text("id,value\na,1\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "range exceeds"):
            tabular.handle({"action": "read", "path": "wide.csv", "range": "A1:ZZ100"})
        Path("groups.csv").write_text("id,value\n2025,2\n", encoding="utf-8")
        summary = tabular.handle({"action": "aggregate", "path": "groups.csv", "group_by": ["id"],
                                  "measures": [{"column": "value", "op": "sum", "as": "total"}]})
        Path("actual.json").write_text(json.dumps({"columns": ["id", "total"], "rows": [[2025, 3]]}), encoding="utf-8")
        strict = tabular.handle({"action": "compare", "dataset_path": summary["dataset_path"], "actual_path": "actual.json",
                                 "keys": ["id"], "columns": ["total"]})
        self.assertFalse(strict["equal"])
        numeric = tabular.handle({"action": "compare", "dataset_path": summary["dataset_path"], "actual_path": "actual.json",
                                  "keys": ["id"], "columns": ["total"], "numeric_keys": ["id"]})
        self.assertFalse(numeric["equal"])
        self.assertEqual(numeric["mismatches"][0]["actual"], 3)
        Path("missing.json").write_text(json.dumps({"columns": ["id", "total"], "rows": []}), encoding="utf-8")
        missing = tabular.handle({"action": "compare", "dataset_path": summary["dataset_path"], "actual_path": "missing.json",
                                  "keys": ["id"], "columns": ["total"]})
        self.assertFalse(missing["equal"])
        self.assertIsNone(missing["mismatches"][0]["actual"])
        make_1904_xlsx("epoch1904.xlsx")
        epoch = tabular.handle({"action": "aggregate", "path": "epoch1904.xlsx", "group_by": [{"column": "when", "transform": "year"}],
                                "measures": [{"column": "value", "op": "sum"}]})
        self.assertEqual(epoch["preview"], [{"when_year": 1904, "sum_value": 7}])
        make_formula_xlsx("formula-actual.xlsx")
        formula_aggregate = tabular.handle({"action": "aggregate", "path": "formula-actual.xlsx", "group_by": ["id"],
                                            "measures": [{"column": "value", "op": "sum"}], "allow_cached_formulas": True})
        self.assertTrue(any("cache" in warning for warning in formula_aggregate["warnings"]))
        Path("expected.csv").write_text("id,value\nx,5\n", encoding="utf-8")
        expected = tabular.handle({"action": "aggregate", "path": "expected.csv", "group_by": ["id"],
                                   "measures": [{"column": "value", "op": "sum", "as": "value"}]})
        compare_args = {"action": "compare", "dataset_path": expected["dataset_path"], "actual_path": "formula-actual.xlsx",
                        "keys": ["id"], "columns": ["value"]}
        with self.assertRaisesRegex(ValueError, "actual column value contains a formula"):
            tabular.handle(compare_args)
        permitted = tabular.handle({**compare_args, "allow_cached_formulas": True})
        self.assertTrue(permitted["equal"])
        self.assertTrue(any("cache" in warning for warning in permitted["warnings"]))

    def test_workspace_symlink_escape_and_xlsx_column_bound(self):
        make_wide_xlsx("too-wide.xlsx")
        with self.assertRaisesRegex(ValueError, "16,384 column limit"):
            tabular.handle({"action": "inspect", "path": "too-wide.xlsx"})
        outside = tempfile.TemporaryDirectory()
        try:
            outside_path = Path(outside.name) / "outside.csv"
            outside_path.write_text("id\na\n", encoding="utf-8")
            try:
                os.symlink(outside_path, "escape.csv")
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable in this Windows environment")
            with self.assertRaisesRegex(ValueError, "inside the workspace"):
                tabular.handle({"action": "inspect", "path": "escape.csv"})
        finally:
            outside.cleanup()

    def test_total_cell_limit_and_source_change_during_read(self):
        row = ",".join(f"v{i}" for i in range(16_384))
        Path("large.csv").write_text("\n".join([row] * 31 + ["last"]), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "500,000 cell limit"):
            tabular.handle({"action": "inspect", "path": "large.csv"})
        Path("changing.csv").write_text("id,value\na,1\n", encoding="utf-8")
        original = tabular._table

        def change_after_read(path, args):
            result = original(path, args)
            Path("changing.csv").write_text("id,value\na,2\n", encoding="utf-8")
            return result

        with patch.object(tabular, "_table", side_effect=change_after_read):
            with self.assertRaisesRegex(ValueError, "source changed"):
                tabular.handle({"action": "inspect", "path": "changing.csv"})

    def test_model_output_byte_bounds_and_nonfinite_rejection(self):
        huge = "z" * 25_000
        Path("long.csv").write_text("group,text\n" + huge + "," + huge + "\n", encoding="utf-8")
        inspected = tabular.handle({"action": "inspect", "path": "long.csv"})
        self.assertLess(tabular._wire_size(inspected), tabular.MAX_RESPONSE_BYTES)
        self.assertTrue(inspected["truncated"])
        read = tabular.handle({"action": "read", "path": "long.csv", "range": "B1:B2"})
        self.assertLess(tabular._wire_size(read), tabular.MAX_RESPONSE_BYTES)
        self.assertTrue(read["truncated"])
        aggregate = tabular.handle({"action": "aggregate", "path": "long.csv", "group_by": ["group"],
                                    "measures": [{"op": "count"}]})
        self.assertLess(tabular._wire_size(aggregate), tabular.MAX_PREVIEW_BYTES)
        saved = json.loads(Path(aggregate["dataset_path"]).read_text(encoding="utf-8"))
        self.assertEqual(len(saved["rows"][0]["group"]), 25_000)
        headers = [f"column_{index}" for index in range(80)]
        Path("wide-columns.csv").write_text(",".join(headers) + "\n" + ",".join(["v"] * len(headers)) + "\n", encoding="utf-8")
        wide = tabular.handle({"action": "inspect", "path": "wide-columns.csv"})
        self.assertEqual(wide["column_count"], 80)
        self.assertEqual(len(wide["columns"]), tabular.MAX_INSPECT_COLUMNS)
        self.assertTrue(wide["truncated"])
        self.assertLess(tabular._wire_size(wide), tabular.MAX_RESPONSE_BYTES)
        Path("nonfinite.xlsx.json").write_text('{"columns":["x"],"rows":[[NaN]]}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "non-finite JSON number"):
            tabular.handle({"action": "inspect", "path": "nonfinite.xlsx.json"})


if __name__ == "__main__":
    unittest.main()
