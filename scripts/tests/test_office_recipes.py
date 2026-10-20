"""Pure validation and command-building tests for reusable OfficeCLI recipes."""

import json
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[2] / "workbench-mcp" / "office_recipes.py"
SPEC = importlib.util.spec_from_file_location("office_recipes", MODULE)
office_recipes = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = office_recipes
SPEC.loader.exec_module(office_recipes)


class OfficeRecipes(unittest.TestCase):
    def test_document_recipe_uses_standard_style_and_one_page_warning(self):
        recipe = office_recipes.prepare({
            "action": "document", "target": "meeting/agenda.docx", "title": "Lab meeting",
            "layout": "one-page", "sections": [{"heading": "Decisions", "paragraphs": ["Choose the next experiment."], "bullets": ["Review samples"]}],
        })
        self.assertEqual(recipe["target"], "meeting/agenda.docx")
        self.assertTrue(any(item["props"].get("listStyle") == "bullet" for item in recipe["commands"]))
        self.assertTrue(any(item.get("path") == "/section[1]" for item in recipe["commands"]))
        title = next(item for item in recipe["commands"] if item["props"].get("text") == "Lab meeting")
        heading = next(item for item in recipe["commands"] if item["props"].get("text") == "Decisions")
        body = next(item for item in recipe["commands"] if item["props"].get("text") == "Choose the next experiment.")
        self.assertEqual(title["props"]["style"], "Title")
        self.assertEqual(heading["props"]["style"], "Heading1")
        self.assertEqual((heading["props"]["size"], heading["props"]["spaceBefore"]), ("13pt", "8pt"))
        self.assertEqual(body["props"]["style"], "Normal")
        self.assertEqual(body["props"]["firstLineIndent"], "0.5in")
        self.assertNotIn("firstLineIndent", title["props"])
        self.assertNotIn("firstLineIndent", heading["props"])
        self.assertIn("not a page-count guarantee", recipe["warnings"][0])

    def test_document_rejects_invalid_content_before_returning_commands(self):
        with self.assertRaisesRegex(ValueError, "paragraphs"):
            office_recipes.prepare({"action": "document", "target": "x.docx", "title": "Notes", "sections": [{"heading": "H", "paragraphs": "not an array"}]})

    def test_table_recipe_styles_headers_and_writes_formulas_and_total(self):
        recipe = office_recipes.prepare({
            "action": "table", "target": "lab-results.xlsx", "sheet": "Results",
            "data": {"columns": ["Sample", "Count", "Rate"], "rows": [
                ["Control", 4, {"formula": "B2/2"}], ["Treated", 6, {"formula": "B3/2"}],
            ]},
            "total_row": {"label": "Total", "numeric_columns": ["Count", "Rate"]},
            "chart": {"type": "column", "title": "Sample counts", "label_column": "Sample", "value_columns": ["Count"]},
        })
        commands = recipe["commands"]
        self.assertTrue(any(c.get("path") == "/Results/A1" and c["props"].get("fill") == "1F3864" and c["props"].get("font.color") == "FFFFFF" and c["props"].get("font.bold") for c in commands))
        self.assertTrue(any(c.get("path") == "/Results/C2" and c["props"].get("formula") == "B2/2" for c in commands))
        self.assertTrue(any(c.get("path") == "/Results/B4" and c["props"].get("formula") == "SUM(B2:B3)" for c in commands))
        chart = next(c for c in commands if c.get("type") == "chart")
        self.assertEqual(chart["props"]["dataRange"], "Results!A1:B3")
        self.assertEqual(chart["props"]["anchor"], "E2:K18")

    def test_source_workbook_adds_summary_instead_of_rebuilding_source(self):
        recipe = office_recipes.prepare({
            "action": "table", "source": "source.xlsx", "target": "copy.xlsx", "sheet": "Summary",
            "data": {"columns": ["Month", "Sales"], "rows": [["Jan", 120]]},
        })
        self.assertEqual(recipe["source"], "source.xlsx")
        self.assertEqual(recipe["commands"][0], {"command": "add", "parent": "/", "type": "sheet", "props": {"name": "Summary"}})
        self.assertFalse(any(c.get("command") == "remove" for c in recipe["commands"]))

    def test_dataset_json_is_read_as_data(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "dataset.json"
            path.write_text(json.dumps({
                "version": 1, "source": "lab.xlsx", "sha256": "abc", "sheet": "Data", "header_row": 1,
                "query": {}, "columns": ["Task", "Hours"], "rows": [{"Task": "Run", "Hours": 2.5}],
            }), encoding="utf-8")
            cwd = os.getcwd()
            try:
                os.chdir(folder)
                recipe = office_recipes.prepare({"action": "table", "target": "out.xlsx", "dataset": "dataset.json"})
            finally:
                os.chdir(cwd)
        self.assertTrue(any(c.get("path") == "/Sheet1/B2" and c["props"].get("value") == 2.5 for c in recipe["commands"]))

    def test_rejects_path_escape_duplicate_headers_ragged_rows_and_formula_literals(self):
        for args, message in [
            ({"action": "table", "target": "../out.xlsx", "data": {"columns": ["A"], "rows": []}}, "workspace"),
            ({"action": "table", "target": "x.xlsx", "data": {"columns": ["A", "a"], "rows": []}}, "unique"),
            ({"action": "table", "target": "x.xlsx", "data": {"columns": ["A"], "rows": [[1, 2]]}}, "exactly"),
            ({"action": "table", "target": "x.xlsx", "data": {"columns": ["A"], "rows": [["=1+1"]]}}, "explicit"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                office_recipes.prepare(args)

    def test_rejects_noncontiguous_chart_columns(self):
        with self.assertRaisesRegex(ValueError, "contiguous"):
            office_recipes.prepare({
                "action": "table", "target": "x.xlsx",
                "data": {"columns": ["Month", "Note", "Sales"], "rows": [["Jan", "ok", 4]]},
                "chart": {"type": "line", "title": "Sales", "label_column": "Month", "value_columns": ["Sales"]},
            })

    def test_formula_literals_and_quoted_sheet_references_are_unambiguous(self):
        recipe = office_recipes.prepare({
            "action": "table", "target": "formula.xlsx", "data": {
                "columns": ["Name", "Result"],
                "rows": [["Trial", {"formula": "'Input Data'!B2+\" units\""}], ["Blank", ""]],
            },
        })
        self.assertTrue(any(c.get("path") == "/Sheet1/B2" and c["props"].get("formula") == "'Input Data'!B2+\" units\"" for c in recipe["commands"]))
        self.assertFalse(any(c.get("path") == "/Sheet1/B3" for c in recipe["commands"]))
        with self.assertRaisesRegex(ValueError, "without a leading"):
            office_recipes.prepare({"action": "table", "target": "literal.xlsx", "data": {"columns": ["X"], "rows": [[{"formula": "=1+1"}]]}})

    def test_formula_columns_expand_only_supported_placeholders_and_override_input(self):
        recipe = office_recipes.prepare({
            "action": "table", "source": "input.xlsx", "target": "summary.xlsx", "sheet": "Summary",
            "data": {"columns": ["Group", "Amount", "Total"], "rows": [["North", 5, None], ["South", 10, 0]]},
            "formula_columns": {"Total": "SUMIF('Source Data'!$A$2:$A$100,A{row},'Source Data'!B$2:B$100)+SUM(B{first_data_row}:B{last_data_row})"},
        })
        formulas = {item["path"]: item["props"]["formula"] for item in recipe["commands"] if "formula" in item.get("props", {})}
        self.assertEqual(formulas["/Summary/C2"], "SUMIF('Source Data'!$A$2:$A$100,A2,'Source Data'!B$2:B$100)+SUM(B2:B3)")
        self.assertEqual(formulas["/Summary/C3"], "SUMIF('Source Data'!$A$2:$A$100,A3,'Source Data'!B$2:B$100)+SUM(B2:B3)")
        with self.assertRaisesRegex(ValueError, "unknown placeholder"):
            office_recipes.prepare({
                "action": "table", "target": "x.xlsx", "data": {"columns": ["X"], "rows": [[1]]},
                "formula_columns": {"X": "SUM(A{row},B{column})"},
            })

    def test_rejects_alternate_data_stream_path(self):
        with self.assertRaisesRegex(ValueError, "workspace"):
            office_recipes.prepare({"action": "table", "target": "report.xlsx:stream", "data": {"columns": ["X"], "rows": []}})


if __name__ == "__main__":
    unittest.main()
