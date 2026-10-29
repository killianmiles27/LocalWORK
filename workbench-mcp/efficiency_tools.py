"""Schemas and dispatch for reusable data and Office operations; no domain presets."""
import json
import shutil
from pathlib import Path


STRING = {'type': 'string'}
STRINGS = {'type': 'array', 'items': STRING}
TOOLS = [
    {'name': 'tabular', 'description': 'Inspect CSV/TSV/XLSX compactly, read bounded cells, aggregate named columns, or compare reusable result datasets. Load office-recipes for examples. Formulas read from XML are cached, not evaluated; use officecli read-ranges for calculated results.',
     'inputSchema': {'type': 'object', 'properties': {
         'action': {'type': 'string', 'enum': ['inspect', 'read', 'aggregate', 'compare']},
         'path': STRING, 'sheet': {'oneOf': [STRING, {'type': 'integer'}]},
         'header_row': {'type': 'integer', 'minimum': 1}, 'range': STRING,
         'sample_rows': {'type': 'integer', 'minimum': 0, 'maximum': 20},
         'limit': {'type': 'integer', 'minimum': 1, 'maximum': 200},
         'group_by': {'type': 'array', 'items': {'oneOf': [STRING, {'type': 'object', 'properties': {
             'column': STRING, 'transform': {'type': 'string', 'enum': ['year', 'month']}}, 'required': ['column', 'transform']}]}},
         'date_format': STRING,
         'measures': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'column': STRING, 'op': {'type': 'string', 'enum': ['sum', 'count', 'mean', 'min', 'max']}, 'as': STRING}, 'required': ['op']}},
         'dataset_path': STRING, 'actual_path': STRING, 'actual_sheet': STRING,
         'actual_header_row': {'type': 'integer'}, 'keys': STRINGS, 'columns': STRINGS,
         'tolerance': {'type': 'number', 'minimum': 0},
         'max_mismatches': {'type': 'integer', 'minimum': 1, 'maximum': 100}}, 'required': ['action']}},
    {'name': 'office_recipe', 'description': 'Create a new formatted Word document or Excel table/chart from validated content or a saved tabular dataset. Refuses to overwrite. Optional source copies a workbook before adding a summary. Recipes are construction, not verification; load office-recipes for details.',
     'inputSchema': {'type': 'object', 'properties': {
         'action': {'type': 'string', 'enum': ['document', 'table']}, 'target': STRING,
         'source': STRING, 'title': STRING, 'layout': {'type': 'string', 'enum': ['standard', 'one-page']}, 'font': STRING,
         'sources': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'figure': STRING, 'value': {}, 'references': {'type': 'array', 'items': {'type': 'object'}}}, 'required': ['figure', 'value']}},
         'sections': {'type': 'array', 'items': {'type': 'object', 'properties': {
             'heading': STRING, 'paragraphs': STRINGS, 'bullets': STRINGS}, 'required': ['heading']}},
         'sheet': STRING, 'dataset': STRING,
         'data': {'type': 'object', 'properties': {'columns': STRINGS, 'rows': {'type': 'array', 'items': {'type': 'array'}}}, 'required': ['columns', 'rows']},
         'formula_columns': {'type': 'object', 'additionalProperties': STRING},
         'total_row': {'type': 'object', 'properties': {'label': STRING, 'numeric_columns': STRINGS}, 'required': ['label', 'numeric_columns']},
         'chart': {'type': 'object', 'properties': {'type': {'type': 'string', 'enum': ['column', 'bar', 'line', 'pie']},
             'title': STRING, 'label_column': STRING, 'value_columns': STRINGS}, 'required': ['type', 'title', 'label_column', 'value_columns']}}, 'required': ['action', 'target']}}
]


def dispatch(name, args, call_tool, executable):
    if name == 'tabular':
        from tabular import handle
        return json.dumps(handle(args), ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    from office_recipes import prepare
    recipe = prepare(args)  # Validate everything before changing a file.
    root = Path.cwd().resolve()
    target = root / recipe['target']
    resolved = target.resolve()
    if not resolved.is_relative_to(root) or not target.parent.is_dir() or target.exists():
        raise ValueError('target must be a new file with an existing parent inside the workspace')
    if recipe.get('source'):
        source = (root / recipe['source']).resolve()
        if not source.is_relative_to(root) or not source.is_file():
            raise ValueError('source must be an existing workbook inside the workspace')
        # Exclusive creation protects an existing file even if it appeared during validation.
        with source.open('rb') as original, target.open('xb') as output:
            shutil.copyfileobj(original, output)
    else:
        call_tool('officecli', {'args': ['create', recipe['target']]})
    try:
        result = call_tool('officecli', {'args': ['batch', recipe['target']], 'commands': recipe['commands']})
    except Exception as error:
        raise RuntimeError(f'Construction incomplete at {recipe["target"]}; partial file preserved. {error}') from error
    return json.dumps({'path': recipe['target'], 'construction': result,
                       'warnings': recipe.get('warnings', []), 'verified': False,
                       'next': 'Verify the content and calculations; page-count check if required. Close and show_document.'}, ensure_ascii=False)
