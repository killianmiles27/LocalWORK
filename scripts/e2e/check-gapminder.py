"""Live integration check for the app's Gapminder recipe, without model inference."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', required=True)
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix='gapminder-recipe-', dir=args.work)).resolve()
    os.environ.update(BROWSER_NODE=str(ROOT/'vendor/node/node.exe'), BROWSER_CLI=str(ROOT/'vendor/playwright/node_modules/@playwright/cli/playwright-cli.js'), BROWSER_BROWSERS=str(ROOT/'vendor/browsers'), BROWSER_PROFILES=str(work/'profiles'), BROWSER_SESSION='recipe-'+uuid.uuid4().hex[:12], CI='1')
    sys.path.insert(0, str(ROOT/'workbench-mcp'))
    import browser
    os.chdir(work)
    trace = []
    def evaluate(js):
        text = browser.run({'command': 'eval', 'args': [js]})
        trace.append(text)
        body = text.split('### Result\n', 1)[1].split('\n### ', 1)[0].strip()
        return json.loads(body)
    try:
        browser.run({'command': 'goto', 'args': ['https://www.gapminder.org/tools/#$chart-type=bubbles&url=v1']})
        for _ in range(30):
            if evaluate('() => { try { return window.Vizabi?.stores?.markers?.models?.bubble?.encoding?.frame?.stepCount > 1; } catch { return false; } }'):
                break
            time.sleep(1)
        recipe = (ROOT/'scripts/e2e/fixtures/gapminder-recipe.md').read_text(encoding='utf-8').split('```js\n', 1)[1].split('\n```', 1)[0].replace('COUNTRY_ISO', 'jpn')
        started = evaluate(recipe)
        assert started['playing'] and started['selected'], started
        state = None
        for _ in range(60):
            time.sleep(2)
            state = evaluate("() => { const M=window.Vizabi.stores.markers.models.bubble.encoding; return {year:M.frame.value, playing:M.frame.playing, selected:Array.from(M.trail.data.filter.markers), starts:M.trail.starts, bubbleCircles:document.querySelectorAll('.vzb-bc-bubbles circle').length}; }")
            if not state['playing']:
                break
        shot = browser.run({'command': 'screenshot'})
        assert state and not state['playing'] and state['selected'] and state['year'] == started['end'], state
        assert str(state['starts'].get('jpn', '')).startswith('1800'), state
        assert state['bubbleCircles'] > started['baselineBubbleCircles'], state
        (work/'results.json').write_text(json.dumps({'status': 'PASS', 'started': started, 'final': state, 'screenshot': shot}, indent=2), encoding='utf-8')
        print(json.dumps({'status': 'PASS', 'work': str(work), 'final': state}, ensure_ascii=True))
    finally:
        (work/'trace.json').write_text(json.dumps(trace, indent=2), encoding='utf-8')
        browser.shutdown()


if __name__ == '__main__':
    main()
