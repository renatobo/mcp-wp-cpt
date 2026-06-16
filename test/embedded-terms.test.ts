import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmbeddedTermField, normalizeEmbeddedTerms } from '../src/tools/unified-taxonomies.js';

test('isEmbeddedTermField treats label arrays as taxonomy terms', () => {
  assert.equal(isEmbeddedTermField('event_type', ['Long ride']), true);
  assert.equal(isEmbeddedTermField('tags', ['news', 'rides']), true);
});

test('isEmbeddedTermField accepts term-id object arrays but excludes known data fields', () => {
  const orgs = [{ term_id: 5, name: 'DROC', slug: 'droc' }];
  assert.equal(isEmbeddedTermField('event_tag', orgs), true);
  assert.equal(isEmbeddedTermField('organizers', orgs), false);
  assert.equal(isEmbeddedTermField('related_events', orgs), false);
});

test('isEmbeddedTermField ignores empty and non-array values', () => {
  assert.equal(isEmbeddedTermField('tags', []), false);
  assert.equal(isEmbeddedTermField('virtual', { enabled: true }), false);
  assert.equal(isEmbeddedTermField('event_type', undefined), false);
});

test('normalizeEmbeddedTerms shapes string and object entries consistently', () => {
  assert.deepEqual(normalizeEmbeddedTerms(['Long ride']), [{ name: 'Long ride' }]);
  assert.deepEqual(
    normalizeEmbeddedTerms([{ term_id: 7, name: 'Rides', slug: 'rides', extra: 'x' }]),
    [{ id: 7, name: 'Rides', slug: 'rides' }]
  );
  assert.deepEqual(normalizeEmbeddedTerms('not-an-array'), []);
});
