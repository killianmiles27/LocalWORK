"""Number provenance across evaluated ranges, aggregations and recipes."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'workbench-mcp'))
import office_ranges
import office_recipes
import tabular
from test_tabular import make_formula_xlsx


class NumberSources(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = os.getcwd()
        os.chdir(self.temp.name)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        os.chdir(self.old)
        self.temp.cleanup()

    def test_evaluated_range_preserves_rows_and_formula_cells(self):
        Path('input.xlsx').write_bytes(b'fixture')
        cells = [{'path': '/Sales/B3', 'text': 'Group', 'format': {'type': 'String'}},
                 {'path': '/Sales/C3', 'text': 'Value', 'format': {'type': 'String'}},
                 {'path': '/Sales/B4', 'text': 'A', 'format': {'type': 'String'}},
                 {'path': '/Sales/C4', 'text': '', 'format': {'type': 'Number', 'formula': '1+1', 'evaluated': True, 'computedValue': '2'}}]
        response = type('Response', (), {'returncode': 0, 'stdout': json.dumps({'success': True, 'data': {'results': [{'children': cells}]}}), 'stderr': ''})()
        with patch.object(office_ranges.subprocess, 'run', return_value=response):
            result = office_ranges.read_ranges({'path': 'input.xlsx', 'ranges': ['/Sales/B3:C4']}, 'unused')
        data = json.loads(Path(result['ranges'][0]['dataset_path']).read_text())
        self.assertEqual(data['row_sources'], [{'row': 4, 'range': 'B4:C4'}])
        self.assertEqual(data['formulas'][0]['cell'], '/Sales/C4')
        self.assertEqual(result['ranges'][0]['preview_row_sources'], [{'row': 4, 'range': 'B4:C4'}])
        aggregate = tabular.handle({'action': 'aggregate', 'path': result['ranges'][0]['dataset_path'], 'measures': [{'column': 'Value', 'op': 'sum'}]})
        ref = aggregate['sources'][0]['references'][0]
        self.assertEqual((ref['file'], ref['sheet'], ref['rows'][0]['cells']), ('input.xlsx', 'Sales', ['C4']))
        grouped = tabular.handle({'action': 'aggregate', 'path': result['ranges'][0]['dataset_path'], 'group_by': ['Group'], 'measures': [{'column': 'Value', 'op': 'sum'}]})
        self.assertEqual(grouped['sources'][0]['references'][0]['rows'][0]['cells'], ['B4', 'C4'])
        with patch.object(office_ranges.subprocess, 'run', return_value=response):
            explicit = office_ranges.read_ranges({'path': 'input.xlsx', 'ranges': ['/Sales/B3:C4'], 'columns': ['Group', 'Value']}, 'unused')
        saved_explicit = json.loads(Path(explicit['ranges'][0]['dataset_path']).read_text())
        self.assertEqual(saved_explicit['row_sources'], [{'row': 3, 'range': 'B3:C3'}, {'row': 4, 'range': 'B4:C4'}])

    def test_evaluated_range_rejects_duplicate_cell_paths(self):
        Path('input.xlsx').write_bytes(b'fixture')
        cells = [{'path': '/S/A1', 'text': 'Value', 'format': {'type': 'String'}},
                 {'path': '/S/A1', 'text': '2', 'format': {'type': 'Number'}}]
        response = type('Response', (), {'returncode': 0, 'stdout': json.dumps({'success': True, 'data': {'results': [{'children': cells}]}}), 'stderr': ''})()
        with patch.object(office_ranges.subprocess, 'run', return_value=response):
            with self.assertRaisesRegex(RuntimeError, 'duplicate'):
                office_ranges.read_ranges({'path': 'input.xlsx', 'ranges': ['/S/A1:A2']}, 'unused')

    def test_grouped_sum_mean_and_compare_include_sources(self):
        Path('input.csv').write_text('group,value\nA,2\nA,4\nB,8\n')
        result = tabular.handle({'action': 'aggregate', 'path': 'input.csv', 'group_by': ['group'], 'measures': [{'column': 'value', 'op': 'sum'}, {'column': 'value', 'op': 'mean'}]})
        figures = {(s['row'], s['column']): s for s in result['sources']}
        self.assertEqual(figures[(1, 'sum_value')]['value'], 6)
        self.assertEqual(figures[(1, 'mean_value')]['value'], 3)
        ref = figures[(1, 'mean_value')]['references'][0]
        self.assertEqual(ref['precision'], 'row')
        self.assertEqual([r['row'] for r in ref['rows']], [2, 3])
        Path('actual.csv').write_text('group,sum_value\nA,7\nB,8\n')
        compared = tabular.handle({'action': 'compare', 'dataset_path': result['dataset_path'], 'actual_path': 'actual.csv', 'keys': ['group'], 'columns': ['sum_value']})
        self.assertFalse(compared['equal'])
        self.assertEqual(compared['sources'][0]['expected']['references'][0]['file'], 'input.csv')
        self.assertEqual(compared['sources'][0]['actual']['references'][0]['file'], 'actual.csv')

    def test_bounded_sources_and_legacy_json(self):
        Path('large.csv').write_text('value\n' + '1\n' * 150)
        result = tabular.handle({'action': 'aggregate', 'path': 'large.csv', 'measures': [{'column': 'value', 'op': 'sum'}]})
        ref = result['sources'][0]['references'][0]
        self.assertTrue(ref['truncated'])
        self.assertLess(len(ref['rows']), 150)
        Path('legacy.json').write_text(json.dumps({'version': 1, 'columns': ['id', 'value'], 'rows': [['A', 5]]}))
        legacy = tabular.handle({'action': 'aggregate', 'path': 'legacy.json', 'group_by': ['id'], 'measures': [{'column': 'value', 'op': 'sum', 'as': 'value'}]})
        self.assertEqual(legacy['sources'][0]['references'][0]['precision'], 'row')
        compared = tabular.handle({'action': 'compare', 'dataset_path': legacy['dataset_path'], 'actual_path': 'legacy.json', 'keys': ['id'], 'columns': ['value']})
        self.assertTrue(compared['equal'])

    def test_chain_inspection_and_reaggregation_keep_original_rows(self):
        Path('source.tsv').write_text('group\tvalue\nA\t2\nA\t4\nB\t8\n')
        inspected = tabular.handle({'action': 'inspect', 'path': 'source.tsv'})
        summed = next(s for s in inspected['sources'] if s.get('column') == 'value' and s['figure'] == 'sum')
        self.assertEqual(summed['value'], 14)
        self.assertEqual([r['row'] for r in summed['references'][0]['rows']], [2, 3, 4])
        first = tabular.handle({'action': 'aggregate', 'path': 'source.tsv', 'group_by': ['group'], 'measures': [{'column': 'value', 'op': 'sum', 'as': 'total'}]})
        second = tabular.handle({'action': 'aggregate', 'path': first['dataset_path'], 'measures': [{'column': 'total', 'op': 'mean'}]})
        reference = second['sources'][0]['references'][0]
        self.assertEqual(reference['file'], 'source.tsv')
        self.assertEqual([r['row'] for r in reference['rows']], [2, 3, 4])
        self.assertEqual(reference['chain'][0]['file'], first['dataset_path'])
        self.assertEqual(second['preview'][0]['mean_total'], 7)

    def test_whole_workbook_is_row_precision_and_keeps_cache_warning(self):
        make_formula_xlsx('cached.xlsx')
        result = tabular.handle({'action': 'aggregate', 'path': 'cached.xlsx', 'group_by': ['id'], 'measures': [{'column': 'value', 'op': 'sum'}], 'allow_cached_formulas': True})
        reference = result['sources'][0]['references'][0]
        self.assertEqual((reference['file'], reference['sheet']), ('cached.xlsx', 'Actual'))
        self.assertEqual(reference['precision'], 'row')
        self.assertEqual(reference['rows'], [{'row': 2}])
        self.assertTrue(any('cache' in warning for warning in result['warnings']))

    def test_count_min_max_and_figure_list_truncation(self):
        Path('values.csv').write_text('group,value\nA,2\nA,4\nB,8\n')
        result = tabular.handle({'action': 'aggregate', 'path': 'values.csv', 'group_by': ['group'], 'measures': [{'op': 'count'}, {'column': 'value', 'op': 'min'}, {'column': 'value', 'op': 'max'}]})
        figures = {(s['row'], s['column']): s for s in result['sources']}
        self.assertEqual(figures[(1, 'count')]['value'], 2)
        self.assertEqual(figures[(1, 'min_value')]['value'], 2)
        self.assertEqual(figures[(1, 'max_value')]['value'], 4)
        self.assertEqual([r['row'] for r in figures[(1, 'max_value')]['references'][0]['rows']], [2, 3])
        Path('many.csv').write_text('group,value\n' + ''.join(f'{i},1\n' for i in range(30)))
        many = tabular.handle({'action': 'aggregate', 'path': 'many.csv', 'group_by': ['group'], 'measures': [{'column': 'value', 'op': 'sum'}]})
        self.assertTrue(many['sources_truncated'])
        saved = json.loads(Path(many['dataset_path']).read_text())
        self.assertEqual(len([s for s in saved['sources'] if s['column'] == 'sum_value']), 30)

    def test_formula_table_is_labelled_when_no_source_was_supplied(self):
        table = office_recipes.prepare({'action': 'table', 'target': 'out.xlsx', 'data': {'columns': ['Value'], 'rows': [[{'formula': '1+1'}]]}})
        notes = [str(c.get('props', {}).get('value', '')) for c in table['commands']]
        self.assertTrue(any('/Sheet1/A2' in text and 'source not supplied' in text for text in notes))

    def test_document_and_table_emit_sources_and_missing_source(self):
        figures = [{'figure': 'Revenue', 'value': 5, 'references': [{'file': 'input.xlsx', 'sheet': 'Data', 'cells': 'B2'}]}, {'figure': 'Margin', 'value': 2}]
        doc = office_recipes.prepare({'action': 'document', 'target': 'report.docx', 'title': 'Report', 'sections': [{'heading': 'Results'}], 'sources': figures})
        text = '\n'.join(str(c.get('props', {}).get('text', '')) for c in doc['commands'])
        for value in ('Sources', 'Revenue', '5', 'input.xlsx', 'Data', 'B2', 'Margin', 'source not supplied'):
            self.assertIn(value, text)
        table = office_recipes.prepare({'action': 'table', 'target': 'out.xlsx', 'data': {'columns': ['Name', 'Value'], 'rows': [['A', 5]]}, 'sources': figures})
        text = '\n'.join(str(c.get('props', {}).get('value', '')) for c in table['commands'])
        for value in ('Sources', 'Revenue', 'input.xlsx', 'B2', 'source not supplied'):
            self.assertIn(value, text)


if __name__ == '__main__':
    unittest.main()
