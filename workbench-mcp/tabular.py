"""Bounded, read-only tabular inspection and aggregation for workspace files."""
import csv
import datetime as dt
import hashlib
import json
import math
import os
import re
import secrets
import zipfile
from decimal import Decimal, InvalidOperation
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

MAX_BYTES = 32 * 1024 * 1024
MAX_CELLS = 500_000
MAX_ROWS = 100_000
MAX_OUTPUT = 20
MAX_MISMATCHES = 100
MAX_INSPECT_COLUMNS = 50
MAX_INSPECT_SHEETS = 20
MAX_RESPONSE_BYTES = 16_000
MAX_PREVIEW_BYTES = 8_000
MAX_TEXT_PREVIEW = 160
MAX_SOURCE_ROWS = 20
MAX_SOURCE_FIGURES = 20
XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def _inside(path, root):
    return os.path.commonpath((os.path.realpath(root), os.path.realpath(path))) == os.path.realpath(root)


def _source_path(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("path must be a workspace-relative file path")
    if ":" in value or os.path.isabs(value):
        raise ValueError("path must be a relative workspace path without alternate data streams")
    root = os.path.realpath(os.getcwd())
    path = os.path.realpath(os.path.join(root, value))
    if not _inside(path, root) or not os.path.isfile(path):
        raise ValueError("path must name an existing file inside the workspace")
    if os.path.getsize(path) > MAX_BYTES:
        raise ValueError("file exceeds the 32 MiB limit")
    if os.path.splitext(path)[1].lower() not in (".csv", ".tsv", ".xlsx", ".json"):
        raise ValueError("supported formats are .csv, .tsv, .xlsx and saved JSON datasets")
    return root, path


def _reject_json_constant(value):
    raise ValueError(f"non-finite JSON number {value} is not supported")


def _json_load(stream):
    value = json.load(stream, parse_constant=_reject_json_constant)
    def check(item):
        if isinstance(item, float) and not math.isfinite(item): raise ValueError("non-finite JSON numbers are not supported")
        if isinstance(item, dict):
            for nested in item.values(): check(nested)
        elif isinstance(item, list):
            for nested in item: check(nested)
    check(value)
    return value


def _wire_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":" )).encode("utf-8"))


def _display_headers(headers, limit):
    displayed, used = [], set()
    for index, header in enumerate(headers[:limit], 1):
        label = header[:40]
        if label in used: label = f"{label} [{index}]"
        used.add(label)
        displayed.append((header, label))
    return displayed


def _bounded_value(value, limit=MAX_TEXT_PREVIEW):
    if isinstance(value, str):
        return (value[:limit] + "…", True) if len(value) > limit else (value, False)
    if isinstance(value, dict):
        result, truncated = {}, False
        for key, item in value.items():
            result[key], was_truncated = _bounded_value(item, limit)
            truncated = truncated or was_truncated
        return result, truncated
    if isinstance(value, list):
        result, truncated = [], False
        for item in value:
            bounded, was_truncated = _bounded_value(item, limit)
            result.append(bounded); truncated = truncated or was_truncated
        return result, truncated
    return _json_value(value), False


def _sha(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _col_num(label):
    number = 0
    for char in label.upper():
        if not "A" <= char <= "Z":
            raise ValueError("invalid Excel column")
        number = number * 26 + ord(char) - 64
    return number


def _col_label(number):
    result = ""
    while number:
        number, rem = divmod(number - 1, 26)
        result = chr(65 + rem) + result
    return result


def _cell_ref(ref):
    match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", ref.upper())
    if not match:
        raise ValueError("invalid cell reference")
    return int(match.group(2)), _col_num(match.group(1))


def _xlsx_sheets(zf):
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    targets = {r.attrib["Id"]: r.attrib["Target"] for r in rels.findall(f"{{{PKG_REL_NS}}}Relationship")}
    result = []
    for node in wb.findall(f".//{{{XLSX_NS}}}sheet"):
        target = targets.get(node.attrib.get(f"{{{REL_NS}}}id"))
        if not target:
            raise ValueError("workbook contains an unresolved sheet relationship")
        if target.startswith("/"):
            member = target.lstrip("/")
        else:
            member = str(PurePosixPath("xl") / target)
        member = str(PurePosixPath(member))
        if member.startswith("../") or member not in zf.namelist():
            raise ValueError("workbook contains an invalid sheet path")
        result.append((node.attrib["name"], member))
    return result


def _xlsx_read(path, sheet):
    with zipfile.ZipFile(path) as zf:
        if sum(info.file_size for info in zf.infolist()) > MAX_BYTES * 4:
            raise ValueError("workbook expands beyond the 128 MiB processing limit")
        sheets = _xlsx_sheets(zf)
        if not sheets:
            raise ValueError("workbook has no worksheets")
        if isinstance(sheet, int) and not isinstance(sheet, bool):
            if sheet < 1 or sheet > len(sheets):
                raise ValueError("sheet index is out of range")
            selected = sheets[sheet - 1]
        elif sheet is None:
            selected = sheets[0]
        else:
            selected = next((item for item in sheets if item[0] == sheet), None)
            if selected is None:
                raise ValueError("unknown worksheet name")
        shared = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in si.iter(f"{{{XLSX_NS}}}t")) for si in root.findall(f"{{{XLSX_NS}}}si")]
        root = ET.fromstring(zf.read(selected[1]))
        workbook = ET.fromstring(zf.read("xl/workbook.xml"))
        workbook_pr = workbook.find(f"{{{XLSX_NS}}}workbookPr")
        date_1904 = workbook_pr is not None and workbook_pr.attrib.get("date1904", "0").lower() in ("1", "true")
        rows = {}
        count = 0
        for row in root.findall(f".//{{{XLSX_NS}}}sheetData/{{{XLSX_NS}}}row"):
            ri = int(row.attrib["r"])
            values = {}
            for cell in row.findall(f"{{{XLSX_NS}}}c"):
                count += 1
                if count > MAX_CELLS:
                    raise ValueError("worksheet exceeds the 500,000 cell limit")
                r, c = _cell_ref(cell.attrib["r"])
                if c > 16_384:
                    raise ValueError("worksheet exceeds the 16,384 column limit")
                if r > MAX_ROWS:
                    raise ValueError("worksheet exceeds the 100,000 row limit")
                typ = cell.attrib.get("t")
                v = cell.find(f"{{{XLSX_NS}}}v")
                formula_node = cell.find(f"{{{XLSX_NS}}}f")
                formula = (formula_node.text or "") if formula_node is not None else None
                raw = (v.text or "") if v is not None else None
                if typ == "inlineStr":
                    inline = cell.find(f"{{{XLSX_NS}}}is")
                    value = "".join(t.text or "" for t in inline.iter(f"{{{XLSX_NS}}}t")) if inline is not None else ""
                elif typ == "s" and raw is not None:
                    try: value = shared[int(raw)]
                    except (ValueError, IndexError): raise ValueError("invalid shared string reference")
                elif typ == "b": value = raw == "1"
                elif typ == "e": value = {"error": raw or "#ERROR!"}
                elif raw is None: value = None
                else:
                    try:
                        value = Decimal(raw)
                        if not value.is_finite(): raise ValueError("workbook contains a non-finite numeric value")
                    except InvalidOperation: value = raw
                values[c] = {"value": value, "formula": formula, "cached": value if formula is not None else None}
            if values:
                rows[ri] = values
        return selected[0], rows, count, len(sheets), [name for name, _ in sheets], date_1904


def _grid(path, args):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".xlsx":
        sheet, raw, cells, sheet_count, sheet_names, date_1904 = _xlsx_read(path, args.get("sheet"))
        return sheet, raw, cells, sheet_count, True, sheet_names, date_1904
    sheet = None
    raw = {}
    dialect_delimiter = "\t" if ext == ".tsv" else ","
    cells = 0
    with open(path, "r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream, delimiter=dialect_delimiter)
        for ri, row in enumerate(reader, 1):
            if ri > MAX_ROWS: raise ValueError("file exceeds the 100,000 row limit")
            if len(row) > 16_384: raise ValueError("row exceeds the 16,384 column limit")
            cells += len(row)
            if cells > MAX_CELLS: raise ValueError("file exceeds the 500,000 cell limit")
            if row:
                raw[ri] = {c: {"value": v if v != "" else None, "formula": None, "cached": None}
                           for c, v in enumerate(row, 1)}
    return sheet, raw, cells, 1, False, [], False


def _json_value(value):
    if isinstance(value, Decimal):
        if not value.is_finite(): raise ValueError("non-finite numeric values are not supported")
        integral = value.to_integral_value()
        if value == integral: return int(integral)
        converted = float(value)
        if not math.isfinite(converted) or converted == 0: raise ValueError("numeric value is outside the finite JSON range")
        return converted
    return value


def _validate_json_provenance(data, root, depth=0, seen=None):
    provenance = data.get("provenance") if isinstance(data, dict) else None
    if provenance is None and isinstance(data, dict) and ("source" in data or "sha256" in data):
        provenance = {"source": data.get("source"), "sha256": data.get("sha256")}
    if provenance is None:
        return
    if depth >= 8: raise ValueError("JSON dataset provenance chain exceeds the 8-file limit")
    seen = set() if seen is None else seen
    if (not isinstance(provenance, dict) or not isinstance(provenance.get("source"), str)
            or not isinstance(provenance.get("sha256"), str) or os.path.isabs(provenance["source"])
            or ":" in provenance["source"]):
        raise ValueError("JSON dataset provenance must contain a relative source path and sha256")
    source = os.path.realpath(os.path.join(root, provenance["source"]))
    if source in seen: raise ValueError("JSON dataset provenance contains a cycle")
    if not _inside(source, root) or not os.path.isfile(source) or os.path.getsize(source) > MAX_BYTES:
        raise ValueError("JSON dataset provenance source must be a bounded workspace file")
    fingerprint = _sha(source)
    if fingerprint != provenance["sha256"]:
        raise ValueError("JSON dataset source changed since evaluation")
    if os.path.splitext(source)[1].lower() == ".json":
        seen.add(source)
        try:
            with open(source, encoding="utf-8") as stream: nested = _json_load(stream)
            if _sha(source) != fingerprint: raise ValueError("JSON dataset source changed during provenance validation")
            _validate_json_provenance(nested, root, depth + 1, seen)
        finally:
            seen.remove(source)


def _table(path, args):
    if os.path.splitext(path)[1].lower() == ".json":
        try:
            with open(path, encoding="utf-8") as stream: data = _json_load(stream)
        except (UnicodeDecodeError, json.JSONDecodeError): raise ValueError("JSON dataset is invalid")
        if not isinstance(data, dict): raise ValueError("JSON dataset must contain columns and rows")
        root = os.path.realpath(os.getcwd())
        _validate_json_provenance(data, root, seen={path})
        headers, rows = data.get("columns"), data.get("rows")
        if not isinstance(headers, list) or not headers or not all(isinstance(h, str) and h for h in headers):
            raise ValueError("JSON dataset columns must be nonempty strings")
        if len(headers) > 16_384 or any(len(h) > 1_024 for h in headers):
            raise ValueError("JSON dataset columns exceed header limits")
        if len(set(headers)) != len(headers): raise ValueError("duplicate column headers are not supported")
        if not isinstance(rows, list) or len(rows) > MAX_ROWS or len(rows) * len(headers) > MAX_CELLS:
            raise ValueError("JSON dataset exceeds row or cell limits")
        records = []
        row_sources = data.get("row_sources")
        if row_sources is not None and (not isinstance(row_sources, list) or len(row_sources) != len(rows)
                or any(not isinstance(r, dict) or not isinstance(r.get("row"), int)
                       or isinstance(r.get("row"), bool) or r["row"] < 1
                       or not isinstance(r.get("range"), str) for r in row_sources)):
            raise ValueError("invalid JSON dataset row_sources")
        for ri, values in enumerate(rows, 1):
            if isinstance(values, list):
                if len(values) != len(headers): raise ValueError("JSON dataset row width does not match columns")
                record = dict(zip(headers, values))
            elif isinstance(values, dict) and all(h in values for h in headers): record = {h: values[h] for h in headers}
            else: raise ValueError("JSON dataset rows must be arrays or column-keyed objects")
            records.append({"_row": ri, **record, "_cells": [],
                            "_row_source": row_sources[ri - 1] if row_sources else None})
        _validate_json_provenance(data, root, seen={path})
        return {"sheet": data.get("sheet"), "sheet_count": 1, "sheet_names": [], "headers": headers, "records": records,
                "sparse": {}, "header_row": 1, "cells": len(rows)*len(headers), "xlsx": False, "date_1904": False,
                "dataset": data, "path": path}
    sheet, sparse, count, sheet_count, xlsx, sheet_names, date_1904 = _grid(path, args)
    header_row = args.get("header_row", 1)
    if not isinstance(header_row, int) or isinstance(header_row, bool) or not 1 <= header_row <= MAX_ROWS:
        raise ValueError("header_row must be an integer from 1 to 100000")
    max_col = max((max(row) for row in sparse.values()), default=0)
    if max_col > 16_384: raise ValueError("table exceeds the 16,384 column limit")
    if not max_col: raise ValueError("table is empty")
    header_cells = sparse.get(header_row, {})
    headers = []
    for c in range(1, max_col + 1):
        value = header_cells.get(c, {}).get("value")
        if value is None or value == "": raise ValueError("header row contains a blank column name")
        name = str(value).strip()
        if not name: raise ValueError("header row contains a blank column name")
        if len(name) > 1024: raise ValueError("column headers cannot exceed 1,024 characters")
        headers.append(name)
    if len(set(headers)) != len(headers): raise ValueError("duplicate column headers are not supported")
    records = []
    for ri in sorted(r for r in sparse if r > header_row):
        row = sparse[ri]
        values = [row.get(c, {}).get("value") for c in range(1, max_col + 1)]
        if not any(v is not None for v in values): continue
        records.append({"_row": ri, **{h: values[i] for i, h in enumerate(headers)},
                        "_cells": [row.get(c, {"value": None, "formula": None, "cached": None}) for c in range(1, max_col + 1)]})
    if len(records) > MAX_ROWS: raise ValueError("table exceeds the 100,000 data row limit")
    for record in records:
        record["_formula_by_column"] = {h: record["_cells"][i]["formula"] is not None for i, h in enumerate(headers)}
    return {"sheet": sheet, "sheet_count": sheet_count, "sheet_names": sheet_names, "headers": headers, "records": records,
            "sparse": sparse, "header_row": header_row, "cells": count, "xlsx": xlsx, "date_1904": date_1904,
            "path": path}


def _source_chain(data):
    chain = []
    seen = set()
    for _ in range(8):
        provenance = data.get("provenance") or ({"source": data.get("source"), "sha256": data.get("sha256")} if data.get("source") else None)
        if not isinstance(provenance, dict) or not provenance.get("source"):
            break
        source = provenance["source"]
        chain.append({"file": source, "sha256": provenance.get("sha256")})
        if not source.lower().endswith(".json") or source in seen:
            break
        seen.add(source)
        with open(source, encoding="utf-8") as stream:
            data = _json_load(stream)
        if not isinstance(data, dict):
            break
    return chain


def _references(table, records, columns):
    """Return bounded contributing references, retaining saved aggregate lineage."""
    data = table.get("dataset", {})
    chain = _source_chain(data)
    path = os.path.relpath(table["path"], os.getcwd()).replace(os.sep, "/")
    refs = []
    inherited = {(item.get("row"), item.get("column")): item for item in data.get("sources", []) if isinstance(item, dict)} if isinstance(data.get("sources", []), list) else {}
    for record in records:
        old = [inherited.get((record["_row"], col)) for col in columns]
        old = [item for item in old if item and isinstance(item.get("references"), list)]
        if old:
            for item in old:
                for ref in item["references"]:
                    if isinstance(ref, dict):
                        refs.append({**ref, "chain": [{"file": path}, *ref.get("chain", [])]})
            continue
        row_source = record.get("_row_source")
        if row_source and chain and chain[0]["file"].lower().endswith(".xlsx") and isinstance(data.get("sheet"), str):
            match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)", row_source["range"])
            original = re.fullmatch(r"/([^/]+)/([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)", str(data.get("range", "")))
            if (not match or not original or original[1] != data["sheet"] or match[1] != original[2]
                    or match[3] != original[4] or int(match[2]) != row_source["row"]
                    or int(match[4]) != row_source["row"] or not int(original[3]) <= row_source["row"] <= int(original[5])):
                raise ValueError("invalid JSON dataset cell range")
            left, right = _col_num(match[1]), _col_num(match[3])
            if right - left + 1 != len(table["headers"]):
                raise ValueError("JSON dataset cell range width does not match columns")
            cells = [f"{_col_label(left + table['headers'].index(col))}{row_source['row']}" for col in columns if col in table["headers"]]
            ref = {"file": chain[0]["file"], "sheet": data["sheet"], "range": data.get("range"), "precision": "cell",
                   "rows": [{"row": row_source["row"], "cells": cells or [row_source["range"]]}], "truncated": False, "chain": [{"file": path}, *chain]}
        else:
            table_range = (f"A{table['header_row']}:{_col_label(len(table['headers']))}{max(table['sparse'], default=table['header_row'])}"
                           if table.get("xlsx") else None)
            ref = {"file": path, "sheet": table.get("sheet"), "range": table_range, "precision": "row",
                   "rows": [{"row": record["_row"]}], "truncated": False, "chain": [{"file": path}, *chain]}
        refs.append(ref)
    merged = []
    for ref in refs:
        identity = (ref.get("file"), ref.get("sheet"), ref.get("range"), ref.get("precision"), json.dumps(ref.get("chain", []), sort_keys=True))
        target = next((r for r in merged if r[0] == identity), None)
        if target is None:
            target = (identity, {**ref, "rows": [], "truncated": bool(ref.get("truncated"))})
            merged.append(target)
        dest = target[1]
        dest["truncated"] |= bool(ref.get("truncated"))
        for row in ref.get("rows", []):
            if row not in dest["rows"]:
                if len(dest["rows"]) < MAX_SOURCE_ROWS:
                    dest["rows"].append(row)
                else:
                    dest["truncated"] = True
    result = [item[1] for item in merged[:MAX_SOURCE_ROWS]]
    if len(merged) > MAX_SOURCE_ROWS and result:
        result[-1]["truncated"] = True
    return result


def _resolve_column(table, name):
    if name not in table["headers"]: raise ValueError(f"unknown column: {name}")
    return name


def _type_summary(values):
    kinds = set()
    numeric = []
    nulls = 0
    for value in values:
        if value is None: nulls += 1
        elif isinstance(value, dict) and "error" in value: kinds.add("error")
        elif isinstance(value, bool): kinds.add("boolean")
        elif isinstance(value, (int, float, Decimal)): kinds.add("number"); numeric.append(Decimal(str(value)))
        else:
            text = str(value)
            try:
                parsed = Decimal(text)
                if not parsed.is_finite(): raise ValueError("column contains a non-finite numeric value")
                kinds.add("number"); numeric.append(parsed)
            except InvalidOperation: kinds.add("text")
    summary = {"types": sorted(kinds) or ["empty"], "nulls": nulls, "values": len(values)}
    if numeric: summary["numeric"] = {"count": len(numeric), "min": _json_value(min(numeric)), "max": _json_value(max(numeric)), "sum": _json_value(sum(numeric, Decimal(0)))}
    return summary


def _inspect(path, args):
    table = _table(path, args)
    sample_n = args.get("sample_rows", 5)
    if not isinstance(sample_n, int) or isinstance(sample_n, bool) or not 0 <= sample_n <= MAX_OUTPUT:
        raise ValueError("sample_rows must be between 0 and 20")
    display_headers = _display_headers(table["headers"], MAX_INSPECT_COLUMNS)
    shown, text_truncated = [], False
    for record in table["records"][:sample_n]:
        row = {}
        for header, label in display_headers:
            row[label], shortened = _bounded_value(record[header])
            text_truncated = text_truncated or shortened
        shown.append(row)
    summaries = {}
    for header, label in display_headers:
        summary, shortened = _bounded_value(_type_summary([r[header] for r in table["records"]]))
        summaries[label] = summary
        text_truncated = text_truncated or shortened or len(header) > 40
    result = {"sheet": (table["sheet"][:40] if isinstance(table["sheet"], str) else table["sheet"]),
              "sheet_count": table["sheet_count"], "sheet_names": [name[:40] for name in table["sheet_names"][:MAX_INSPECT_SHEETS]],
              "range": f"A{table['header_row']}:{_col_label(len(table['headers']))}{max(table['sparse'], default=table['header_row'])}",
              "header_row": table["header_row"], "rows": len(table["records"]), "column_count": len(table["headers"]),
              "columns": [label for _, label in display_headers], "column_summary": summaries, "sample": shown,
              "truncated": len(display_headers) < len(table["headers"]) or len(table["sheet_names"]) > MAX_INSPECT_SHEETS
              or any(len(name) > 40 for name in table["sheet_names"]) or text_truncated}
    result["sources"] = [{"figure": "rows", "value": len(table["records"]),
                          "references": _references(table, table["records"], [])}]
    for header, label in display_headers:
        summary = result["column_summary"][label]
        numeric = summary.get("numeric")
        figures = [("values", summary["values"], table["records"]),
                   ("nulls", summary["nulls"], [r for r in table["records"] if r[header] is None])]
        if numeric:
            numeric_records = [r for r in table["records"] if "number" in _type_summary([r[header]])["types"]]
            figures.extend((op, value, numeric_records) for op, value in numeric.items())
        for op, value, records in figures:
            if len(result["sources"]) < MAX_SOURCE_FIGURES:
                result["sources"].append({"column": label, "figure": op, "value": value,
                                          "references": _references(table, records, [header])})
            else:
                result["sources_truncated"] = True
    while result["sources"] and _wire_size(result) > MAX_RESPONSE_BYTES:
        result["sources"].pop()
        result["sources_truncated"] = True
    while result["sample"] and _wire_size(result) > MAX_RESPONSE_BYTES:
        result["sample"].pop()
        result["truncated"] = True
    if _wire_size(result) > MAX_RESPONSE_BYTES:
        result["sample"] = []
        result["column_summary"] = {}
        result["columns"] = result["columns"][:10]
        result["sheet_names"] = result["sheet_names"][:10]
        result["truncated"] = True
    return result


def _read(path, args):
    table = _table(path, args)
    if os.path.splitext(path)[1].lower() == ".json":
        limit = args.get("limit", MAX_OUTPUT)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200:
            raise ValueError("limit must be between 1 and 200")
        display_headers = _display_headers(table["headers"], MAX_INSPECT_COLUMNS)
        result = {"sheet": table["sheet"][:40] if isinstance(table["sheet"], str) else table["sheet"], "header_row": 1, "columns": [label for _, label in display_headers],
                  "column_count": len(table["headers"]), "rows": [], "total_rows": len(table["records"]), "truncated": len(display_headers) < len(table["headers"])}
        for record in table["records"][:limit]:
            row_values = [_bounded_value(record[h]) for h, _ in display_headers]
            row = [value for value, _ in row_values]
            if any(shortened for _, shortened in row_values): result["truncated"] = True
            result["rows"].append(row)
            if _wire_size(result) > MAX_RESPONSE_BYTES:
                result["rows"].pop(); result["truncated"] = True; break
        if len(result["rows"]) < min(limit, len(table["records"])): result["next_row"] = len(result["rows"]) + 1
        return result
    ref = args.get("range")
    if ref is not None:
        match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)", str(ref).upper())
        if not match: raise ValueError("range must look like A1:C20")
        c1, r1, c2, r2 = _col_num(match.group(1)), int(match.group(2)), _col_num(match.group(3)), int(match.group(4))
        if c2 < c1 or r2 < r1 or r2 - r1 + 1 > 200 or (c2-c1+1)*(r2-r1+1) > 4000: raise ValueError("range exceeds the read limit")
    else:
        limit = args.get("limit", 100)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200: raise ValueError("limit must be between 1 and 200")
        r1 = table["header_row"]
        r2, c1, c2 = min(max(table["sparse"], default=r1), r1 + limit), 1, len(table["headers"])
    rows = []
    text_truncated = False
    next_cell = None
    for r in range(r1, r2+1):
        cells = []
        for c in range(c1, c2+1):
            cell = table["sparse"].get(r, {}).get(c, {"value": None, "formula": None, "cached": None})
            value, value_short = _bounded_value(cell["value"])
            formula, formula_short = _bounded_value(cell["formula"])
            item = {"cell": f"{_col_label(c)}{r}", "value": value, "formula": formula}
            if cell["formula"] is not None:
                item["cached_value"], cached_short = _bounded_value(cell["cached"])
                if cached_short: item["truncated"] = True; text_truncated = True
            if value_short or formula_short:
                item["truncated"] = True
                text_truncated = True
            cells.append(item)
            if _wire_size({"rows": rows + [cells]}) > MAX_RESPONSE_BYTES - 1200:
                cells.pop()
                next_cell = f"{_col_label(c)}{r}"
                break
        if cells: rows.append(cells)
        if next_cell: break
    result = {"sheet": (table["sheet"][:40] if isinstance(table["sheet"], str) else table["sheet"]),
            "header_row": table["header_row"], "range": ref or f"{_col_label(c1)}{r1}:{_col_label(c2)}{r2}",
            "formula_note": "cached_value is stored in the workbook and may be stale; formulas are not evaluated",
            "rows": rows}
    if text_truncated or next_cell:
        result["truncated"] = True
    if next_cell: result["next_cell"] = next_cell
    return result


def _decimal(value, label):
    if isinstance(value, dict) and "error" in value: raise ValueError(f"{label} contains an Excel error")
    if value is None or value == "": raise ValueError(f"{label} contains a missing value")
    if isinstance(value, bool): raise ValueError(f"{label} contains a nonnumeric value")
    try: number = Decimal(str(value))
    except InvalidOperation: raise ValueError(f"{label} contains a nonnumeric value")
    if not number.is_finite(): raise ValueError(f"{label} contains a non-finite value")
    if number.adjusted() > 308: raise ValueError(f"{label} exceeds the supported numeric range")
    return number


def _date_part(value, transform, date_format, date_epoch):
    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
        try:
            if date_epoch == "1900" and date_format is None:
                day = dt.datetime(1899, 12, 30) + dt.timedelta(days=float(value))
            elif date_epoch == "1904" and date_format is None:
                day = dt.datetime(1904, 1, 1) + dt.timedelta(days=float(value))
            elif date_format:
                day = dt.datetime.strptime(str(value), date_format)
            else:
                raise ValueError("numeric date values require an XLSX date system or explicit date_format")
        except OverflowError: raise ValueError(f"date value {value!r} is outside the supported date range")
    else:
        text = str(value)
        if date_format:
            try: day = dt.datetime.strptime(text, date_format)
            except ValueError: raise ValueError(f"date value {text!r} does not match date_format")
        else:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:[T ].*)?", text):
                raise ValueError("text dates require an explicit date_format; ISO dates use YYYY-MM-DD")
            try: day = dt.datetime.fromisoformat(text)
            except ValueError: raise ValueError(f"invalid ISO date: {text}")
    return day.year if transform == "year" else f"{day.year:04d}-{day.month:02d}"


def _aggregate(root, path, args, initial_fingerprint):
    table = _table(path, args)
    groups = args.get("group_by", [])
    measures = args.get("measures")
    if not isinstance(groups, list) or not isinstance(measures, list) or not measures: raise ValueError("group_by must be a list and measures must be a nonempty list")
    if len(groups) > 20 or len(measures) > 20: raise ValueError("aggregate queries support at most 20 groups and 20 measures")
    group_defs = []
    names = []
    for item in groups:
        if isinstance(item, str): col, transform = item, None
        elif isinstance(item, dict): col, transform = item.get("column"), item.get("transform")
        else: raise ValueError("each group_by item must be a column name or transform object")
        _resolve_column(table, col)
        if transform not in (None, "year", "month"): raise ValueError("group transform must be year or month")
        out = f"{col}_{transform}" if transform else col
        if out in names: raise ValueError("duplicate group output column")
        names.append(out); group_defs.append((col, transform, out))
    measure_defs = []
    for item in measures:
        if not isinstance(item, dict): raise ValueError("each measure must be an object")
        col, op = item.get("column"), item.get("op")
        if op not in ("sum", "count", "mean", "min", "max"): raise ValueError("measure op must be sum, count, mean, min or max")
        if op == "count" and col is not None: raise ValueError("count counts rows in each group and does not take a column")
        if op != "count": _resolve_column(table, col)
        out = item.get("as") or (f"{op}_{col}" if col else "count")
        if not isinstance(out, str) or not out or out in names: raise ValueError("measure output names must be unique nonempty strings")
        names.append(out); measure_defs.append((col, op, out))
    date_format = args.get("date_format")
    if date_format is not None and not isinstance(date_format, str): raise ValueError("date_format must be a strptime format string")
    allow_cached = args.get("allow_cached_formulas", False)
    if not isinstance(allow_cached, bool): raise ValueError("allow_cached_formulas must be a boolean")
    formula_used = False
    used_columns = {col for col, _, _ in group_defs}
    used_columns.update(col for col, op, _ in measure_defs if op != "count")
    for record in table["records"]:
        for col in used_columns:
            if record.get("_formula_by_column", {}).get(col):
                formula_used = True
                if not allow_cached: raise ValueError(f"column {col} contains a formula; set allow_cached_formulas:true to use its saved cache")
    grouped = {}
    if not group_defs and table["records"]:
        grouped[()] = [{"count": 0, "sum": Decimal(0), "values": []} for _ in measure_defs]
    for record in table["records"]:
        keyvals = []
        for col, transform, _ in group_defs:
            if record.get("_formula_by_column", {}).get(col):
                formula_used = True
            value = record[col]
            if transform:
                if value is None: raise ValueError(f"date group column {col} contains a missing value")
                date_epoch = ("1904" if table["date_1904"] else "1900") if table["xlsx"] else None
                value = _date_part(value, transform, date_format, date_epoch)
            keyvals.append(value)
        key = tuple(keyvals)
        if key not in grouped: grouped[key] = [{"count": 0, "sum": Decimal(0), "values": []} for _ in measure_defs]
        for i, (col, op, _) in enumerate(measure_defs):
            state = grouped[key][i]
            if op == "count": state["count"] += 1; continue
            if record.get("_formula_by_column", {}).get(col):
                formula_used = True
            value = _decimal(record[col], f"column {col}")
            state["values"].append(value); state["sum"] += value
    source_records = {key: [] for key in grouped}
    for record in table["records"]:
        key = tuple(_date_part(record[col], transform, date_format, ("1904" if table["date_1904"] else "1900") if table["xlsx"] else None) if transform else record[col]
                    for col, transform, _ in group_defs)
        source_records[key].append(record)
    output = []
    source_by_key = {}
    for key, states in grouped.items():
        row = {d[2]: _json_value(v) for d, v in zip(group_defs, key)}
        for (col, op, out), state in zip(measure_defs, states):
            vals = state["values"]
            if op == "count": value = state["count"]
            elif not vals: raise ValueError(f"measure {out} has no values")
            elif op == "sum": value = state["sum"]
            elif op == "mean": value = state["sum"] / len(vals)
            elif op == "min": value = min(vals)
            else: value = max(vals)
            row[out] = _json_value(value)
        output.append(row)
        source_by_key[key] = {out: _references(table, source_records[key], list(dict.fromkeys([*(c for c, _, _ in group_defs), *([col] if col else [])]))) for col, _, out in measure_defs}
        source_by_key[key].update({out: _references(table, source_records[key], [col]) for col, _, out in group_defs})
    output.sort(key=lambda row: tuple(str(row[n]) for n in names))
    figure_sources = []
    for index, row in enumerate(output, 1):
        key = tuple(row[d[2]] for d in group_defs)
        for _, _, out in [*measure_defs, *group_defs]:
            figure_sources.append({"row": index, "column": out, "value": row[out], "references": source_by_key[key][out]})
    fingerprint = initial_fingerprint
    if _sha(path) != fingerprint: raise ValueError("source changed during aggregation; retry with a stable file")
    rel_source = os.path.relpath(path, root).replace(os.sep, "/")
    record = {"version": 1, "source": rel_source, "sha256": fingerprint, "sheet": table["sheet"], "header_row": table["header_row"],
              "query": {"group_by": groups, "measures": measures, "date_format": date_format,
                        "allow_cached_formulas": allow_cached}, "columns": names, "rows": output, "sources": figure_sources}
    data_dir = os.path.join(root, ".localwork-data")
    os.makedirs(data_dir, exist_ok=True)
    if not _inside(data_dir, root): raise ValueError(".localwork-data must be inside the workspace")
    filename = secrets.token_hex(16) + ".json"
    destination = os.path.join(data_dir, filename)
    with open(destination, "x", encoding="utf-8") as stream: json.dump(record, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if _sha(path) != fingerprint:
        os.remove(destination)
        raise ValueError("source changed during aggregation; retry with a stable file")
    rel_data = os.path.relpath(destination, root).replace(os.sep, "/")
    preview_headers = _display_headers(names, MAX_INSPECT_COLUMNS)
    preview_rows, preview_truncated = [], len(preview_headers) < len(names)
    result = {"rows": len(output), "columns": [label for _, label in preview_headers], "column_count": len(names),
              "preview": [], "dataset_path": rel_data, "source_sha256": fingerprint,
              "query": _bounded_value(record["query"])[0], "sources": figure_sources[:MAX_SOURCE_FIGURES],
              "sources_truncated": len(figure_sources) > MAX_SOURCE_FIGURES}
    for row in output[:MAX_OUTPUT]:
        preview_row = {}
        for name, label in preview_headers:
            value, shortened = _bounded_value(row[name], 80)
            preview_row[label] = value
            preview_truncated = preview_truncated or shortened or len(name) > 40
        result["preview"].append(preview_row)
        if _wire_size(result) > MAX_PREVIEW_BYTES:
            result["preview"].pop(); preview_truncated = True; break
    if len(result["preview"]) < min(MAX_OUTPUT, len(output)): preview_truncated = True
    result["preview_truncated"] = preview_truncated
    if formula_used: result["warnings"] = ["Used workbook-saved formula cache values; formulas were not evaluated and caches may be stale."]
    while result["sources"] and _wire_size(result) > MAX_PREVIEW_BYTES:
        result["sources"].pop()
        result["sources_truncated"] = True
    while result["preview"] and _wire_size(result) > MAX_PREVIEW_BYTES:
        result["preview"].pop()
        result["preview_truncated"] = True
    if _wire_size(result) > MAX_PREVIEW_BYTES:
        result["query"] = {"group_by_count": len(groups), "measure_count": len(measures)}
        result["columns"] = result["columns"][:10]
        result["preview"] = []
        result["preview_truncated"] = True
    return result


def _compare(root, args):
    rel = args.get("dataset_path")
    if not isinstance(rel, str) or not rel.startswith(".localwork-data/") or ".." in PurePosixPath(rel).parts:
        raise ValueError("dataset_path must be an opaque path returned by aggregate")
    saved_path = os.path.realpath(os.path.join(root, rel.replace("/", os.sep)))
    if not _inside(saved_path, os.path.join(root, ".localwork-data")) or not os.path.isfile(saved_path) or os.path.getsize(saved_path) > MAX_BYTES:
        raise ValueError("saved dataset path is invalid")
    saved_fingerprint = _sha(saved_path)
    with open(saved_path, encoding="utf-8") as stream: saved = _json_load(stream)
    if _sha(saved_path) != saved_fingerprint: raise ValueError("saved dataset changed during comparison")
    _validate_json_provenance(saved, root, seen={saved_path})
    source = os.path.realpath(os.path.join(root, saved.get("source", "")))
    if not _inside(source, root) or not os.path.isfile(source) or _sha(source) != saved.get("sha256"):
        raise ValueError("aggregate source changed since it was computed; recompute before comparing")
    actual_path = _source_path(args.get("actual_path"))[1]
    actual_args = {"sheet": args.get("actual_sheet"), "header_row": args.get("actual_header_row", 1)}
    actual_fingerprint = _sha(actual_path)
    actual = _table(actual_path, actual_args)
    if _sha(actual_path) != actual_fingerprint: raise ValueError("actual dataset changed during comparison")
    keys, columns = args.get("keys"), args.get("columns")
    if not isinstance(keys, list) or not keys or not isinstance(columns, list) or not columns: raise ValueError("keys and columns must be nonempty lists")
    if len(set(keys)) != len(keys) or len(set(columns)) != len(columns): raise ValueError("keys and columns cannot contain duplicates")
    for col in keys + columns: _resolve_column({"headers": saved["columns"]}, col); _resolve_column(actual, col)
    tolerance = args.get("tolerance", 0)
    if len(str(tolerance)) > 64: raise ValueError("tolerance must be a finite nonnegative number")
    try: tolerance = Decimal(str(tolerance))
    except InvalidOperation: raise ValueError("tolerance must be a finite nonnegative number")
    if not tolerance.is_finite() or tolerance < 0: raise ValueError("tolerance must be a finite nonnegative number")
    maximum = args.get("max_mismatches", 20)
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= MAX_MISMATCHES: raise ValueError("max_mismatches must be between 1 and 100")
    allow_cached = args.get("allow_cached_formulas", False)
    if not isinstance(allow_cached, bool): raise ValueError("allow_cached_formulas must be a boolean")
    formula_used = False
    for row in actual["records"]:
        for col in keys + columns:
            if row.get("_formula_by_column", {}).get(col):
                formula_used = True
                if not allow_cached: raise ValueError(f"actual column {col} contains a formula; set allow_cached_formulas:true to use its saved cache")
    numeric_keys = args.get("numeric_keys", [])
    if not isinstance(numeric_keys, list) or any(col not in keys for col in numeric_keys):
        raise ValueError("numeric_keys must be a list of selected key columns")
    def normalize_key(key):
        result = []
        for col, value in zip(keys, key):
            if col in numeric_keys:
                value = _decimal(value, f"key {col}")
            result.append(value)
        return tuple(result)
    def index(rows):
        result = {}
        for row in rows:
            key = normalize_key(tuple(row[k] for k in keys))
            if key in result: raise ValueError("comparison keys are not unique")
            result[key] = row
        return result
    left = index([{**row, "_source_index": i} for i, row in enumerate(saved["rows"], 1)])
    right = index(actual["records"])
    saved_table = _table(saved_path, {})
    figures = []
    figures_truncated = False
    mismatches = []
    mismatch_total = 0
    for key in sorted(set(left) | set(right), key=str):
        for col in columns:
            a = left.get(key, {}).get(col); b = right.get(key, {}).get(col)
            if len(figures) < MAX_SOURCE_FIGURES:
                left_row, right_row = left.get(key), right.get(key)
                expected_record = saved_table["records"][left_row["_source_index"] - 1] if left_row else None
                figures.append({"key": [_bounded_value(v, 100)[0] for v in key], "column": col,
                                "expected": {"value": _json_value(a), "references": _references(saved_table, [expected_record], [col]) if expected_record else []},
                                "actual": {"value": _json_value(b), "references": _references(actual, [right_row], [col]) if right_row else []}})
            else:
                figures_truncated = True
            same = a == b
            if not same and a is not None and b is not None:
                try: same = abs(_decimal(a, col) - _decimal(b, col)) <= tolerance
                except ValueError: same = False
            if not same:
                mismatch_total += 1
                if len(mismatches) < maximum:
                    mismatches.append({"key": [_bounded_value(v, 100)[0] for v in key], "column": col[:100],
                                       "expected": _bounded_value(a, 100)[0], "actual": _bounded_value(b, 100)[0]})
    result = {"equal": not mismatches and set(left) == set(right), "compared_keys": len(set(left) | set(right)),
              "mismatch_count": mismatch_total, "mismatch_count_reported": len(mismatches), "mismatches": mismatches, "tolerance": str(tolerance),
              "sources": figures, "sources_truncated": figures_truncated}
    while result["sources"] and _wire_size(result) > MAX_RESPONSE_BYTES:
        result["sources"].pop()
        result["sources_truncated"] = True
    output_truncated = mismatch_total > len(mismatches)
    while result["mismatches"] and _wire_size(result) > MAX_RESPONSE_BYTES:
        result["mismatches"].pop()
        result["mismatch_count_reported"] -= 1
        output_truncated = True
    if output_truncated: result["truncated"] = True
    result["equal"] = mismatch_total == 0 and set(left) == set(right)
    if formula_used: result["warnings"] = ["Used workbook-saved formula cache values; formulas were not evaluated and caches may be stale."]
    return result


def handle(args):
    """Dispatch one tabular action and return a JSON-serializable result."""
    if not isinstance(args, dict): raise ValueError("arguments must be an object")
    action = args.get("action")
    if action == "compare":
        root = os.path.realpath(os.getcwd())
        return _compare(root, args)
    root, path = _source_path(args.get("path"))
    fingerprint = _sha(path)
    if action == "inspect": result = _inspect(path, args)
    elif action == "read": result = _read(path, args)
    elif action == "aggregate": result = _aggregate(root, path, args, fingerprint)
    else: raise ValueError("action must be inspect, read, aggregate or compare")
    if _sha(path) != fingerprint: raise ValueError("source changed while reading; retry with a stable file")
    return result
