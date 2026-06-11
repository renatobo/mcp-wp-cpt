import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseContentPayload } from '../src/content/payloads.js';

test('buildBaseContentPayload preserves the generic content write shape', () => {
  const payload = buildBaseContentPayload(
    {
      title: 'Hello',
      content: 'Body',
      status: 'draft',
      categories: [1, 2],
      meta: {
        seo_title: 'SEO'
      },
      custom_fields: {
        event_color: 'blue'
      }
    },
    'create'
  );

  assert.deepEqual(payload, {
    title: 'Hello',
    content: 'Body',
    status: 'draft',
    categories: [1, 2],
    meta: {
      seo_title: 'SEO'
    },
    event_color: 'blue'
  });
});

test('buildBaseContentPayload omits undefined fields on update', () => {
  const payload = buildBaseContentPayload(
    {
      title: 'Updated',
      content: undefined,
      custom_fields: {
        venue: 'HQ'
      }
    },
    'update'
  );

  assert.deepEqual(payload, {
    title: 'Updated',
    venue: 'HQ'
  });
});
