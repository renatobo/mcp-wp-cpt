import test from 'node:test';
import assert from 'node:assert/strict';
import { applyContentEdit } from '../src/tools/unified-content.js';

test('append and prepend wrap the existing content', () => {
  assert.equal(applyContentEdit('body', { operation: 'append', value: '!' }), 'body!');
  assert.equal(applyContentEdit('body', { operation: 'prepend', value: '>' }), '>body');
});

test('insert_before and insert_after place the value around the target', () => {
  const existing = 'one TARGET two';
  assert.equal(
    applyContentEdit(existing, { operation: 'insert_before', value: '[x]', target_text: 'TARGET' }),
    'one [x]TARGET two'
  );
  assert.equal(
    applyContentEdit(existing, { operation: 'insert_after', value: '[x]', target_text: 'TARGET' }),
    'one TARGET[x] two'
  );
});

test('replace swaps the target text in place', () => {
  assert.equal(
    applyContentEdit('price: OLD', { operation: 'replace', value: 'NEW', target_text: 'OLD' }),
    'price: NEW'
  );
});

test('occurrence disambiguates repeated targets', () => {
  const existing = 'x x x';
  assert.equal(
    applyContentEdit(existing, { operation: 'replace', value: 'Y', target_text: 'x', occurrence: 2 }),
    'x Y x'
  );
});

test('ambiguous target without occurrence throws', () => {
  assert.throws(
    () => applyContentEdit('x x', { operation: 'replace', value: 'Y', target_text: 'x' }),
    /matched 2 locations/
  );
});

test('missing target text throws', () => {
  assert.throws(
    () => applyContentEdit('abc', { operation: 'replace', value: 'Y', target_text: 'zzz' }),
    /was not found/
  );
});

test('targeted operations require target_text', () => {
  assert.throws(
    () => applyContentEdit('abc', { operation: 'replace', value: 'Y' }),
    /target_text is required/
  );
});
