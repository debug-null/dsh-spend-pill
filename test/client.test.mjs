import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, name);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function load(name, extra = '') {
  return vm.runInNewContext(`${extra}\n${extractFunction(name)}\n${name}`);
}

const formatCny = load('formatCny');
const placePanel = load('placePanel', 'const PANEL_MARGIN = 12; const PANEL_GAP = 8;');

test('formatCny keeps a positive sub-0.0001 amount visible', () => {
  const formatted = formatCny(0.00004, 4);
  assert.match(formatted, /[1-9]/);
  assert.doesNotMatch(formatted, /^0[.,]0+$/);
  assert.match(formatCny(10), /^10[.,]00$/);
  assert.match(formatCny(0.5), /^0[.,]500$/);
  assert.equal(formatCny(Number.NaN), '0.0000');
  const tiny = formatCny(0.00000002, 4);
  assert.match(tiny, /2/);
  assert.doesNotMatch(tiny, /^0[.,]0+$/);
});

test('placePanel clamps to the viewport and flips below the trigger', () => {
  const centered = placePanel(
    { left: 400, width: 80, top: 500, bottom: 520 },
    { width: 200, height: 100 },
    { width: 1000, height: 800 },
  );
  assert.equal(centered.left, 340);
  assert.equal(centered.top, 392);

  const flipped = placePanel(
    { left: 10, width: 40, top: 20, bottom: 40 },
    { width: 300, height: 120 },
    { width: 800, height: 600 },
  );
  assert.equal(flipped.left, 12);
  assert.equal(flipped.top, 48);
});

test('the open dialog subscribes to viewport changes and figure changes', () => {
  assert.match(source, /window\.addEventListener\('resize', place\)/);
  assert.match(source, /window\.addEventListener\('scroll', place, true\)/);
  assert.match(source, /\[open, layoutKey\]/);
  assert.match(source, /cost\.note\.fallback', \{\s*model:/);
});
