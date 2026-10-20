"""Pure OfficeCLI recipes. These build command arrays; callers own file I/O and dispatch."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any


MAX_ROWS = 2_000
MAX_COLUMNS = 32
MAX_TEXT = 20_000
MAX_DATASET_BYTES = 4 * 1024 * 1024
_SHEET = re.compile(r"^[^\\/?*\[\]:]{1,31}$")
_FONT = re.compile(r"^[\w .-]{1,64}$", re.UNICODE)


def _relative_file(value: Any, field: str, suffix: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a workspace-relative {suffix} path")
    path = Path(value)
    if path.is_absolute() or any(part in ("..", "") for part in path.parts) or ":" in value or any(ord(char) < 32 for char in value):
        raise ValueError(f"{field} must stay inside the workspace")
    normalized = path.as_posix()
    if path.suffix.lower() != suffix:
        raise ValueError(f"{field} must end in {suffix}")
    try:
        path.resolve().relative_to(Path.cwd().resolve())
    except ValueError as error:
        raise ValueError(f"{field} must resolve inside the workspace") from error
    return normalized


def _text(value: Any, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > MAX_TEXT or (not allow_empty and not value.strip()):
        raise ValueError(f"{field} must be a {'possibly empty ' if allow_empty else ''}string up to {MAX_TEXT} characters")
    return value


def _column_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _cell(value: Any, field: str) -> tuple[Any, bool]:
    if isinstance(value, dict):
        if set(value) != {"formula"}:
            raise ValueError(f"{field} formula cells must contain only a formula key")
        formula = _text(value["formula"], f"{field}.formula")
        if formula.startswith("="):
            raise ValueError(f"{field}.formula must be an OfficeCLI formula without a leading =")
        return formula, True
    if value is None or isinstance(value, (str, bool)):
        if isinstance(value, str) and value.startswith("="):
            raise ValueError(f"{field} formula must use the explicit {{formula: ...}} form")
        return _text(value, field, allow_empty=True) if isinstance(value, str) else value, False
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value, False
    raise ValueError(f"{field} must be text, a finite number, boolean, null, or {{formula: ...}}")


def _props_command(command: str, path: str, props: dict[str, Any]) -> dict[str, Any]:
    return {"command": command, "path": path, "props": props}


def _document(args: dict[str, Any]) -> dict[str, Any]:
    target = _relative_file(args.get("target"), "target", ".docx")
    title = _text(args.get("title"), "title")
    sections = args.get("sections")
    if not isinstance(sections, list) or not sections:
        raise ValueError("sections must be a non-empty array")
    layout = args.get("layout", "standard")
    if layout not in ("standard", "one-page"):
        raise ValueError("layout must be 'standard' or 'one-page'")
    font = args.get("font", "Calibri")
    if not isinstance(font, str) or not _FONT.fullmatch(font):
        raise ValueError("font must be a short plain font name")

    commands: list[dict[str, Any]] = []
    if layout == "one-page":
        commands.append(_props_command("set", "/section[1]", {
        "marginTop": "0.65in", "marginBottom": "0.65in",
            "marginLeft": "0.75in", "marginRight": "0.75in",
        }))
    commands.append({"command": "add", "parent": "/body", "type": "paragraph", "props": {
        "text": title, "style": "Title", "font": font, "size": "20pt" if layout == "one-page" else "24pt", "bold": True,
        "spaceAfter": "6pt" if layout == "one-page" else "10pt",
    }})
    word_count = len(title.split())
    for index, section in enumerate(sections):
        if not isinstance(section, dict) or set(section) - {"heading", "paragraphs", "bullets"}:
            raise ValueError(f"sections[{index}] must contain only heading, paragraphs, and bullets")
        heading = _text(section.get("heading"), f"sections[{index}].heading")
        paragraphs = section.get("paragraphs", [])
        bullets = section.get("bullets", [])
        if not isinstance(paragraphs, list) or not isinstance(bullets, list):
            raise ValueError(f"sections[{index}] paragraphs and bullets must be arrays")
        paragraphs = [_text(item, f"sections[{index}].paragraphs[{i}]") for i, item in enumerate(paragraphs)]
        bullets = [_text(item, f"sections[{index}].bullets[{i}]") for i, item in enumerate(bullets)]
        word_count += len(heading.split()) + sum(len(text.split()) for text in paragraphs + bullets)
        commands.append({"command": "add", "parent": "/body", "type": "paragraph", "props": {
            "text": heading, "style": "Heading1", "font": font, "size": "13pt" if layout == "one-page" else "16pt", "bold": True, "color": "1F3864",
            "spaceBefore": "8pt" if layout == "one-page" else "14pt", "spaceAfter": "3pt" if layout == "one-page" else "4pt",
        }})
        for paragraph in paragraphs:
            commands.append({"command": "add", "parent": "/body", "type": "paragraph", "props": {
                "text": paragraph, "style": "Normal", "font": font, "size": "11pt", "firstLineIndent": "0.5in", "spaceAfter": "6pt",
            }})
        for bullet in bullets:
            commands.append({"command": "add", "parent": "/body", "type": "paragraph", "props": {
                "text": bullet, "font": font, "size": "11pt", "spaceAfter": "3pt", "listStyle": "bullet",
            }})
    warnings = ["One-page layout is a concise formatting preset, not a page-count guarantee; verify pagination when required."] if layout == "one-page" else []
    if layout == "one-page" and word_count > 450:
        warnings.append(f"Content is about {word_count} words; shorten it before expecting a one-page result.")
    return {"target": target, "commands": commands, "warnings": warnings}


def _table_data(args: dict[str, Any]) -> tuple[list[str], list[list[Any]]]:
    data = args.get("data")
    persisted = False
    if data is None:
        dataset = args.get("dataset")
        if not isinstance(dataset, str) or not dataset.strip():
            raise ValueError("provide data or a dataset path")
        path = Path(_relative_file(dataset, "dataset", ".json"))
        try:
            path.resolve().relative_to(Path.cwd().resolve())
        except ValueError as error:
            raise ValueError("dataset must resolve inside the workspace") from error
        if not path.is_file() or path.stat().st_size > MAX_DATASET_BYTES:
            raise ValueError(f"dataset must be an existing file no larger than {MAX_DATASET_BYTES // (1024 * 1024)} MiB")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError(f"could not read dataset JSON: {error}") from error
        persisted = True
    if not isinstance(data, dict) or not {"columns", "rows"}.issubset(data):
        raise ValueError("data must contain columns and rows")
    if not persisted and set(data) != {"columns", "rows"}:
        raise ValueError("inline data must have exactly columns and rows")
    if persisted and "version" in data and data.get("version") != 1:
        raise ValueError("unsupported saved dataset version")
    columns, rows = data["columns"], data["rows"]
    if not isinstance(columns, list) or not 1 <= len(columns) <= MAX_COLUMNS:
        raise ValueError(f"columns must contain 1 to {MAX_COLUMNS} labels")
    names = [_text(item, f"columns[{i}]") for i, item in enumerate(columns)]
    if len({name.casefold() for name in names}) != len(names):
        raise ValueError("column labels must be unique")
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise ValueError(f"rows must be an array of at most {MAX_ROWS} rows")
    normalized = []
    text_size = 0
    for row_index, row in enumerate(rows):
        if isinstance(row, dict):
            if not all(name in row for name in names):
                raise ValueError(f"rows[{row_index}] must contain a value for every column")
            row = [row[name] for name in names]
        if not isinstance(row, list) or len(row) != len(names):
            raise ValueError(f"rows[{row_index}] must have exactly {len(names)} cells or be keyed by column")
        cells = [_cell(value, f"rows[{row_index}][{col}]") for col, value in enumerate(row)]
        text_size += sum(len(value) for value, is_formula in cells if isinstance(value, str))
        if text_size > MAX_DATASET_BYTES:
            raise ValueError("table text and formulas exceed the 4 MiB recipe limit")
        normalized.append(cells)
    return names, normalized


def _table(args: dict[str, Any]) -> dict[str, Any]:
    target = _relative_file(args.get("target"), "target", ".xlsx")
    source = _relative_file(args["source"], "source", ".xlsx") if args.get("source") is not None else None
    if source and source.casefold() == target.casefold():
        raise ValueError("source and target must be different paths")
    sheet = args.get("sheet", "Summary" if source else "Sheet1")
    if not isinstance(sheet, str) or not _SHEET.fullmatch(sheet) or sheet.startswith("'") or sheet.endswith("'"):
        raise ValueError("sheet must be a valid Excel sheet name (1–31 characters)")
    if not source and sheet.casefold() == "sheet1":
        sheet = "Sheet1"
    columns, rows = _table_data(args)
    formula_columns = args.get("formula_columns", {})
    if not isinstance(formula_columns, dict):
        raise ValueError("formula_columns must map existing column labels to formula templates")
    templates: dict[int, str] = {}
    for name, template_value in formula_columns.items():
        if name not in columns:
            raise ValueError(f"formula_columns names unknown column {name!r}")
        template = _text(template_value, f"formula_columns[{name!r}]")
        placeholders = re.findall(r"\{([^{}]*)\}", template)
        if any(token not in {"row", "first_data_row", "last_data_row"} for token in placeholders):
            raise ValueError(f"formula_columns[{name!r}] contains an unknown placeholder")
        if "{" in template.replace("{row}", "").replace("{first_data_row}", "").replace("{last_data_row}", "") or "}" in template.replace("{row}", "").replace("{first_data_row}", "").replace("{last_data_row}", ""):
            raise ValueError(f"formula_columns[{name!r}] contains unmatched braces")
        if template.startswith("="):
            raise ValueError(f"formula_columns[{name!r}] must omit a leading =")
        templates[columns.index(name)] = template

    commands: list[dict[str, Any]] = []
    if source or sheet != "Sheet1":
        commands.append({"command": "add", "parent": "/", "type": "sheet", "props": {"name": sheet}})
    header_path = f"/{sheet}/A1"
    for col, name in enumerate(columns, 1):
        cell = f"/{sheet}/{_column_name(col)}1"
        commands.append(_props_command("set", cell, {"value": name, "fill": "1F3864", "font.color": "FFFFFF", "font.bold": True}))
        width = min(36, max(12, len(name) + 2))
        commands.append(_props_command("set", f"/{sheet}/col[{_column_name(col)}]", {"width": str(width)}))
    for row_index, row in enumerate(rows, 2):
        for col, (value, formula) in enumerate(row, 1):
            if col - 1 in templates:
                template = templates[col - 1]
                value = (template.replace("{row}", str(row_index))
                         .replace("{first_data_row}", "2")
                         .replace("{last_data_row}", str(len(rows) + 1)))
                formula = True
            if not formula and value in (None, ""):
                continue
            props = {"formula" if formula else "value": value}
            commands.append(_props_command("set", f"/{sheet}/{_column_name(col)}{row_index}", props))

    total_row = args.get("total_row")
    if total_row is not None:
        if not isinstance(total_row, dict) or set(total_row) != {"label", "numeric_columns"}:
            raise ValueError("total_row must have label and numeric_columns")
        label = _text(total_row["label"], "total_row.label")
        numeric = total_row["numeric_columns"]
        if not isinstance(numeric, list) or not numeric or len(set(numeric)) != len(numeric):
            raise ValueError("total_row.numeric_columns must be a non-empty array of unique labels")
        if any(name not in columns for name in numeric):
            raise ValueError("total_row.numeric_columns must name existing columns")
        if columns[0] in numeric:
            raise ValueError("the first column is reserved for the total label")
        for name in numeric:
            col_index = columns.index(name)
            for row_index, row in enumerate(rows):
                value, formula = row[col_index]
                if not formula and value not in (None, "") and (not isinstance(value, (int, float)) or isinstance(value, bool)):
                    raise ValueError(f"total_row column {name!r} has a non-numeric value in row {row_index + 1}")
        total_index = len(rows) + 2
        commands.append(_props_command("set", header_path.replace("A1", f"A{total_index}"), {"value": label, "font.bold": True}))
        for name in numeric:
            col = _column_name(columns.index(name) + 1)
            start, end = (2, len(rows) + 1)
            formula = f"SUM({col}{start}:{col}{end})" if rows else "0"
            commands.append(_props_command("set", f"/{sheet}/{col}{total_index}", {"formula": formula, "font.bold": True}))

    chart = args.get("chart")
    if chart is not None:
        if not isinstance(chart, dict) or set(chart) != {"type", "title", "label_column", "value_columns"}:
            raise ValueError("chart must have type, title, label_column, and value_columns")
        chart_type = chart["type"]
        if chart_type not in ("column", "bar", "line", "pie"):
            raise ValueError("chart.type must be column, bar, line, or pie")
        title = _text(chart["title"], "chart.title")
        label = chart["label_column"]
        values = chart["value_columns"]
        if label not in columns or not isinstance(values, list) or not values or any(v not in columns for v in values):
            raise ValueError("chart columns must name existing columns; value_columns must be non-empty")
        indices = [columns.index(label), *(columns.index(v) for v in values)]
        if len(set(indices)) != len(indices) or indices != list(range(indices[0], indices[0] + len(indices))):
            raise ValueError("chart label_column and value_columns must be contiguous in that order")
        if chart_type == "pie" and len(values) != 1:
            raise ValueError("pie charts require exactly one value column")
        for name in values:
            col_index = columns.index(name)
            for row_index, row in enumerate(rows):
                value, formula = row[col_index]
                if not formula and value not in (None, "") and (not isinstance(value, (int, float)) or isinstance(value, bool)):
                    raise ValueError(f"chart value column {name!r} has a non-numeric value in row {row_index + 1}")
        if not rows:
            raise ValueError("chart requires at least one data row")
        first_col, last_col = _column_name(indices[0] + 1), _column_name(indices[-1] + 1)
        chart_row_end = len(rows) + 1
        commands.append({"command": "add", "parent": f"/{sheet}", "type": "chart", "props": {
            "chartType": chart_type, "dataRange": f"{sheet}!{first_col}1:{last_col}{chart_row_end}",
            "title": title, "anchor": f"{_column_name(len(columns) + 2)}2:{_column_name(len(columns) + 8)}18",
        }})
    warnings = [f"Confirm the copied workbook has no existing sheet named {sheet!r} before dispatching the batch."] if source else []
    return {"target": target, **({"source": source} if source else {}), "commands": commands, "warnings": warnings}


def prepare(args: dict[str, Any]) -> dict[str, Any]:
    """Validate one recipe and return OfficeCLI batch commands without executing them."""
    if not isinstance(args, dict):
        raise ValueError("recipe arguments must be an object")
    action = args.get("action")
    if action == "document":
        return _document(args)
    if action == "table":
        return _table(args)
    raise ValueError("action must be 'document' or 'table'")
