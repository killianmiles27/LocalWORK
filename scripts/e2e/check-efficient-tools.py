"""Real OfficeCLI checks of generic data reuse, formulas, charts and document recipes."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo / 'workbench-mcp'))
    spec = importlib.util.spec_from_file_location('workbench_test', repo / 'workbench-mcp/server.py')
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    server.OFFICECLI = str(repo / 'vendor/officecli.exe')
    parent = Path(args.work).resolve(strict=True)
    root = Path(tempfile.mkdtemp(prefix='efficient-tools-', dir=parent)).resolve()
    assert root.parent == parent
    os.chdir(root)
    files = []
    try:
        # Inventory and experimental observations deliberately have no household-specific fields.
        Path('inventory.csv').write_text('Region,Units\nNorth,2\nSouth,5\nNorth,3\n', encoding='utf-8')
        def call(name, **kwargs):
            return server.call_tool(name, kwargs)
        profile = json.loads(call('read_attachment', path='inventory.csv'))
        assert 'Region' in str(profile) and len(json.dumps(profile)) < 3000
        result = json.loads(call('tabular', action='aggregate', path='inventory.csv', group_by=['Region'],
                                 measures=[{'column': 'Units', 'op': 'sum', 'as': 'Units'}]))
        call('office_recipe', action='table', target='source.xlsx',
             data={'columns': ['Region', 'Units'], 'rows': [['North', 2], ['South', 5], ['North', 3]]})
        files.append('source.xlsx')
        call('officecli', args=['close', 'source.xlsx'])
        call('office_recipe', action='table', source='source.xlsx', target='inventory-summary.xlsx',
             sheet='By Region', dataset=result['dataset_path'],
             formula_columns={'Units': "SUMIF(Sheet1!$A$2:$A$4,A{row},Sheet1!$B$2:$B$4)"},
             total_row={'label': 'Total', 'numeric_columns': ['Units']},
             chart={'type': 'column', 'title': 'Inventory by region', 'label_column': 'Region', 'value_columns': ['Units']})
        files.append('inventory-summary.xlsx')
        calculated = json.loads(call('officecli', args=['read-ranges', 'inventory-summary.xlsx'], ranges=['/By Region/A1:B3']))
        compared = json.loads(call('tabular', action='compare', dataset_path=result['dataset_path'],
                                  actual_path=calculated['ranges'][0]['dataset_path'], keys=['Region'], columns=['Units']))
        assert compared['equal'], compared
        assert calculated['ranges'][0]['formula_count'] == 2
        call('office_recipe', action='document', target='experiment-note.docx', title='Experiment note', layout='one-page',
             sections=[{'heading': 'Method', 'paragraphs': ['Three observations were recorded in two groups.']},
                       {'heading': 'Checks', 'bullets': ['Retain source observations.', 'Compare calculated values before interpretation.']}])
        files.append('experiment-note.docx')
        for filename in files:
            verification = call('officecli', args=['verify', filename])
            assert 'Verification commands completed' in verification and 'FAILED' not in verification, verification
            assert 'Found 0 issue(s):' in verification, verification
            call('officecli', args=['close', filename])
        with zipfile.ZipFile('inventory-summary.xlsx') as archive:
            assert any('/charts/chart' in name for name in archive.namelist())
            assert 'SUMIF(' in archive.read('xl/worksheets/sheet2.xml').decode()
        with zipfile.ZipFile('experiment-note.docx') as archive:
            assert 'Experiment note' in archive.read('word/document.xml').decode()
        print(json.dumps({'status': 'PASS', 'formula_comparison': compared, 'artifacts': str(root)}))
    finally:
        for filename in files:
            subprocess.run([server.OFFICECLI, 'close', str(root / filename)], capture_output=True, timeout=10)


if __name__ == '__main__':
    main()
