"""Bounded bulk reads through OfficeCLI's formula evaluator, not XLSX caches."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import uuid


def _inside(value, exists=True):
    root = Path.cwd().resolve()
    path = (root / str(value)).resolve()
    if not path.is_relative_to(root) or path == root or ':' in str(value).replace('\\', '/'):
        raise ValueError('path must be relative and inside the workspace')
    if exists and not path.is_file():
        raise ValueError('file does not exist')
    if exists and path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('workbook exceeds the 32 MiB read limit')
    return path


def _column(s):
    n = 0
    for ch in s:
        n = n * 26 + ord(ch) - 64
    return n


def read_ranges(args, executable):
    path = _inside(args['path'])
    if path.suffix.lower() != '.xlsx':
        raise ValueError('read-ranges requires .xlsx')
    ranges = args.get('ranges')
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= 8:
        raise ValueError('ranges must contain 1 to 8 /Sheet/A1:C20 paths')
    total = 0
    for value in ranges:
        match = re.fullmatch(r'/([^/]+)/([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)', str(value))
        if not match:
            raise ValueError('use a forward rectangular range such as /Sheet1/A1:C20')
        _, a, r, b, s = match.groups()
        width, height = _column(b) - _column(a) + 1, int(s) - int(r) + 1
        if width <= 0 or height <= 0 or _column(b) > 16384 or int(s) > 1048576:
            raise ValueError('invalid range bounds')
        total += width * height
    if total > 2000:
        raise ValueError('read-ranges supports at most 2000 cells per call')
    fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
    directory = _inside('.localwork-data', exists=False)
    directory.mkdir(exist_ok=True)
    results = []
    for value in ranges:
        result = subprocess.run([executable, 'get', str(path), value, '--json'],
                                capture_output=True, text=True, timeout=30,
                                creationflags=0x08000000 if os.name == 'nt' else 0,
                                stdin=subprocess.DEVNULL)
        if result.returncode:
            raise RuntimeError('OfficeCLI range read failed: ' + (result.stderr or result.stdout)[-2000:])
        if hashlib.sha256(path.read_bytes()).hexdigest() != fingerprint:
            raise RuntimeError('Workbook changed during range evaluation; read again after edits finish')
        payload = json.loads(result.stdout)
        nodes = payload.get('data', {}).get('results', [])
        if payload.get('success') is not True or len(nodes) != 1:
            raise RuntimeError('OfficeCLI did not return one successful range result')
        cells = nodes[0].get('children', [])
        match = re.fullmatch(r'/([^/]+)/([A-Z]+)([0-9]+):([A-Z]+)([0-9]+)', value)
        sheet, col, start, endcol, end = match.groups()
        left, right, start, end = _column(col), _column(endcol), int(start), int(end)
        if len(cells) != (right - left + 1) * (end - start + 1):
            raise RuntimeError('OfficeCLI returned an incomplete range; use a smaller range')
        grid = [[None] * (right - left + 1) for _ in range(end - start + 1)]
        formulas = []
        seen_cells = set()
        for cell in cells:
            ref = re.fullmatch(re.escape('/' + sheet + '/') + r'([A-Z]+)([0-9]+)', cell.get('path', ''))
            if not ref:
                raise RuntimeError('OfficeCLI returned an invalid cell path')
            x, y = _column(ref[1]) - left, int(ref[2]) - start
            if not 0 <= y < len(grid) or not 0 <= x < len(grid[0]):
                raise RuntimeError('OfficeCLI returned a cell outside the requested range')
            if (x, y) in seen_cells:
                raise RuntimeError('OfficeCLI returned a duplicate cell path')
            seen_cells.add((x, y))
            fmt = cell.get('format', {})
            if fmt.get('formula'):
                if fmt.get('evaluated') is not True or 'computedValue' not in fmt:
                    raise RuntimeError(f'Formula at {cell["path"]} was not evaluated; no cached value was substituted')
                formulas.append({'cell': cell['path'], 'formula': fmt['formula']})
            raw = fmt.get('computedValue') if fmt.get('formula') else cell.get('text', '')
            if fmt.get('type') == 'Error' or str(raw).startswith(('#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#NUM!', '#N/A')):
                raise RuntimeError(f'Spreadsheet error at {cell["path"]}: {raw}')
            if fmt.get('empty') or raw is None or raw == '':
                item = None
            elif fmt.get('type') == 'Number':
                item = float(raw)
                if not math.isfinite(item):
                    raise ValueError('non-finite evaluated number')
            elif fmt.get('type') == 'Boolean':
                item = str(raw).lower() in ('true', '1')
            else:
                item = str(raw)
            grid[y][x] = item
        columns = args.get('columns')
        data_start = start
        if columns is None:
            columns, grid = grid[0], grid[1:]
            data_start += 1
        if not isinstance(columns, list) or len(columns) != right - left + 1 or any(not isinstance(c, str) or not c.strip() for c in columns) or len(set(columns)) != len(columns):
            raise ValueError('range header must contain unique nonempty text; otherwise provide explicit columns')
        provenance = {'source': str(path.relative_to(Path.cwd().resolve())).replace('\\', '/'),
                      'sha256': fingerprint}
        dataset = {'version': 1, 'columns': columns, 'rows': grid, 'provenance': provenance,
                   'evaluation': 'OfficeCLI computed values', 'sheet': sheet, 'range': value,
                   'formulas': formulas,
                   'row_sources': [{'row': row, 'range': f'{col}{row}:{endcol}{row}'}
                                   for row in range(data_start, end + 1)]}
        saved = directory / (uuid.uuid4().hex + '.json')
        with saved.open('x', encoding='utf-8') as handle:
            json.dump(dataset, handle, ensure_ascii=False, allow_nan=False)
        preview = []
        for row in grid[:20]:
            if len(json.dumps(preview + [row], ensure_ascii=False)) > 4000:
                break
            preview.append(row)
        results.append({'range': value, 'sheet': sheet, 'source': provenance,
                        'columns': columns, 'row_count': len(grid), 'preview': preview,
                        'preview_row_sources': dataset['row_sources'][:len(preview)],
                        'preview_truncated': len(preview) < len(grid),
                        'formula_count': len(formulas), 'formulas': formulas[:20],
                        'formulas_truncated': len(formulas) > 20,
                        'dataset_path': '.localwork-data/' + saved.name})
    if hashlib.sha256(path.read_bytes()).hexdigest() != fingerprint:
        raise RuntimeError('Workbook changed during range evaluation; read again after edits finish')
    return {'evaluation': 'OfficeCLI computed values, not cached XML values', 'ranges': results}
