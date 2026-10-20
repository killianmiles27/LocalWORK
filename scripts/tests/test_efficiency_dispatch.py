"""Integration boundaries: no overwrite, no hidden cache substitution, bounded range reads."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'workbench-mcp'))
import efficiency_tools
import office_ranges


class EfficiencyDispatch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.before = Path.cwd()
        os.chdir(self.temp.name)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        os.chdir(self.before)
        self.temp.cleanup()

    def test_validation_and_existing_target_do_not_write_or_run(self):
        Path('note.docx').write_bytes(b'keep')
        calls = []
        with self.assertRaises(ValueError):
            efficiency_tools.dispatch('office_recipe', {'action': 'document', 'target': 'note.docx', 'title': 'Title',
                                                        'sections': [{'heading': 'Section'}]}, lambda *a: calls.append(a), 'unused')
        self.assertEqual(Path('note.docx').read_bytes(), b'keep')
        self.assertEqual(calls, [])
        with self.assertRaises(ValueError):
            office_ranges.read_ranges({'path': '../outside.xlsx', 'ranges': ['/S/A1:B2']}, 'unused')

    def test_failed_build_reports_preserved_partial_file(self):
        Path('input.xlsx').write_bytes(b'source')
        def fail(*args):
            raise RuntimeError('operation 2 failed')
        with self.assertRaisesRegex(RuntimeError, 'partial file preserved'):
            efficiency_tools.dispatch('office_recipe', {'action': 'table', 'source': 'input.xlsx', 'target': 'output.xlsx',
                                                        'data': {'columns': ['Name'], 'rows': [['x']]}}, fail, 'unused')
        self.assertEqual(Path('input.xlsx').read_bytes(), b'source')
        self.assertEqual(Path('output.xlsx').read_bytes(), b'source')

    def test_formula_requires_evaluator_not_cached_value(self):
        Path('result.xlsx').write_bytes(b'fixture')
        children = [{'path': '/S/A1', 'text': 'Result', 'format': {'type': 'String'}},
                    {'path': '/S/A2', 'text': '999', 'format': {'type': 'Number', 'formula': '1+1', 'cachedValue': '999'}}]
        payload = {'success': True, 'data': {'results': [{'children': children}]}}
        result = type('Result', (), {'stdout': json.dumps(payload), 'stderr': '', 'returncode': 0})()
        with patch.object(office_ranges.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, 'not evaluated'):
                office_ranges.read_ranges({'path': 'result.xlsx', 'ranges': ['/S/A1:A2']}, 'unused')
        children[1]['format'].update(evaluated=True, computedValue='2')
        result.stdout = json.dumps(payload)
        with patch.object(office_ranges.subprocess, 'run', return_value=result):
            out = office_ranges.read_ranges({'path': 'result.xlsx', 'ranges': ['/S/A1:A2']}, 'unused')
        saved = json.loads(Path(out['ranges'][0]['dataset_path']).read_text(encoding='utf-8'))
        self.assertEqual(saved['rows'], [[2]])
        self.assertIn('sha256', saved['provenance'])

    def test_range_limits_apply_before_subprocess(self):
        Path('result.xlsx').write_bytes(b'fixture')
        with patch.object(office_ranges.subprocess, 'run') as execute:
            for bounds in ['/S/B2:A1', '/S/A1:ZZ99999', '/S/A0:B1']:
                with self.assertRaises(ValueError):
                    office_ranges.read_ranges({'path': 'result.xlsx', 'ranges': [bounds]}, 'unused')
            execute.assert_not_called()

    def test_concurrent_workbook_change_cannot_label_old_values_with_new_hash(self):
        Path('result.xlsx').write_bytes(b'old')
        def changed(*args, **kwargs):
            Path('result.xlsx').write_bytes(b'new')
            return type('Result', (), {'stdout': '{}', 'stderr': '', 'returncode': 0})()
        with patch.object(office_ranges.subprocess, 'run', side_effect=changed):
            with self.assertRaisesRegex(RuntimeError, 'changed during range evaluation'):
                office_ranges.read_ranges({'path': 'result.xlsx', 'ranges': ['/S/A1:A2']}, 'unused')
        self.assertFalse(list(Path('.localwork-data').glob('*.json')))


if __name__ == '__main__':
    unittest.main()
