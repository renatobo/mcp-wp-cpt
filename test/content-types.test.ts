import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContentTypeResolverDependencies,
  clearContentTypeCache,
  getSiteTypes,
  resolveContentEndpoint,
  resolveContentType
} from '../src/content/content-types.js';
import { getContentEndpoint } from '../src/content/utils.js';
import { buildGetContentRequest, buildListContentRequest } from '../src/content/read-preparation.js';
import { buildContentDeleteRequest } from '../src/content/write-preparation.js';
import { assertRelativeEndpoint } from '../src/wordpress.js';
import { ContractResolution } from '../src/adapters/types.js';

const TYPES = {
  post: { slug: 'post', rest_base: 'posts' },
  page: { slug: 'page', rest_base: 'pages' },
  wp_block: { slug: 'wp_block', rest_base: 'blocks' },
  book: { slug: 'book', rest_base: 'library-books' }
};

function deps(overrides: Partial<ContentTypeResolverDependencies> = {}): ContentTypeResolverDependencies & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveSiteId: (siteId?: string) => siteId || 'default',
    request: (async (method: string, endpoint: string) => {
      calls.push(`${method} ${endpoint}`);
      return TYPES;
    }) as any,
    listContracts: async () => [{ contract: { slug: 'ajde_events' } }],
    ...overrides
  };
}

function genericResolution(contentType: string): ContractResolution {
  return {
    siteId: 'default',
    contentType,
    status: 'not_contract_backed',
    issues: [],
    executionSupport: { executable: false, issues: [] }
  };
}

test.beforeEach(() => clearContentTypeCache());

const UNSAFE_CONTENT_TYPES = [
  'https://attacker.example/c',
  '//attacker.example/c',
  '../../wc/v3/orders',
  'posts/../users',
  'posts?context=edit',
  'posts#x',
  'my type',
  'posts\n',
  ''
];

for (const contentType of UNSAFE_CONTENT_TYPES) {
  test(`rejects unsafe content type ${JSON.stringify(contentType)} before any request`, async () => {
    const d = deps();
    await assert.rejects(() => resolveContentType(contentType, 'site-a', d), /Invalid content type/);
    assert.throws(() => getContentEndpoint(contentType), /Invalid content type/);
    assert.deepEqual(d.calls, []);
  });
}

test('resolves a slug to its rest_base', async () => {
  assert.equal(await resolveContentEndpoint('book', 'site-a', deps()), 'library-books');
  assert.equal(await resolveContentEndpoint('wp_block', 'site-a', deps()), 'blocks');
  assert.equal(await resolveContentEndpoint('post', 'site-a', deps()), 'posts');
});

test('accepts a rest_base and returns the canonical slug', async () => {
  const resolved = await resolveContentType('library-books', 'site-a', deps());
  assert.deepEqual(resolved, { slug: 'book', restBase: 'library-books', source: 'types' });
});

test('accepts contract-backed slugs that are not exposed in /types', async () => {
  const resolved = await resolveContentType('ajde_events', 'site-a', deps());
  assert.deepEqual(resolved, { slug: 'ajde_events', restBase: 'ajde_events', source: 'contract' });
});

test('rejects unknown content types and lists the available ones', async () => {
  await assert.rejects(
    () => resolveContentType('ghost', 'site-a', deps()),
    /Unknown content type "ghost".*book \(rest_base: library-books\).*ajde_events/
  );
});

test('refreshes /types once before rejecting an unknown type', async () => {
  let served = 0;
  const d = deps({
    request: (async () => {
      served += 1;
      return served === 1 ? TYPES : { ...TYPES, late: { rest_base: 'late-items' } };
    }) as any
  });
  assert.equal(await resolveContentEndpoint('late', 'site-a', d), 'late-items');
  assert.equal(served, 2);
});

test('caches /types per site', async () => {
  const d = deps();
  await resolveContentEndpoint('book', 'site-a', d);
  await resolveContentEndpoint('page', 'site-a', d);
  await resolveContentEndpoint('page', 'site-b', d);
  assert.deepEqual(d.calls, ['GET types', 'GET types']);
});

test('falls back to the validated slug when /types cannot be fetched', async () => {
  const d = deps({
    request: (async () => {
      throw new Error('503');
    }) as any
  });
  assert.deepEqual(await resolveContentType('post', 'site-a', d), { slug: 'post', restBase: 'posts', source: 'fallback' });
  assert.equal(await resolveContentEndpoint('book', 'site-a', d), 'book');
  await assert.rejects(() => resolveContentType('https://attacker.example/x', 'site-a', d), /Invalid content type/);
});

test('rejects a site-provided rest_base that is not a plain relative path', async () => {
  const d = deps({
    request: (async () => ({ evil: { rest_base: 'https://attacker.example/x' } })) as any
  });
  await assert.rejects(() => resolveContentType('evil', 'site-a', d), /unsupported rest_base/);
});

test('builders use the resolved rest_base for generic content types', () => {
  const list = buildListContentRequest({}, genericResolution('book'), 'library-books');
  assert.equal(list.endpoint, 'library-books');
  assert.equal(list.namespace, 'wp/v2');

  const get = buildGetContentRequest(genericResolution('book'), 'library-books');
  assert.equal(get.endpoint, 'library-books');

  const del = buildContentDeleteRequest({
    contentType: 'book',
    id: 7,
    contractResolution: genericResolution('book'),
    endpoint: 'library-books'
  });
  assert.equal(del.endpoint, 'library-books/7');
});

test('makeWordPressRequest endpoint guard rejects absolute and traversal endpoints', () => {
  for (const endpoint of [
    'https://attacker.example/x',
    '//attacker.example/x',
    '../../wc/v3/orders',
    'posts/%2e%2e/users',
    'posts\\..\\users',
    'a/%2e%2e%2fusers',
    'posts/%2F%2Fattacker.example',
    'posts/%5c..',
    'posts/%E0%A4%A'
  ]) {
    assert.throws(() => assertRelativeEndpoint(endpoint), /unsafe endpoint/, endpoint);
  }

  for (const endpoint of ['posts', '/posts/12', 'posts?slug=a.b', 'types', '']) {
    assert.doesNotThrow(() => assertRelativeEndpoint(endpoint), endpoint);
  }
});

test('resolves ajde_events with no contract and absent from /types, and lists via eventonapify with wp/v2 fallback', async () => {
  const d = deps({
    listContracts: async () => {
      throw new Error('manifest unavailable');
    }
  });
  const resolved = await resolveContentType('ajde_events', 'site-a', d);
  assert.deepEqual(resolved, { slug: 'ajde_events', restBase: 'ajde_events', source: 'fallback' });

  const list = buildListContentRequest({}, genericResolution('ajde_events'), resolved.restBase);
  assert.equal(list.endpoint, 'events');
  assert.equal(list.namespace, 'eventonapify/v1');
  assert.deepEqual(list.fallbackOn404, {
    endpoint: 'ajde_events',
    namespace: 'wp/v2',
    on403Codes: ['eventon_apify_disabled', 'eventon_apify_capability_disabled'],
    data: {}
  });

  const get = buildGetContentRequest(genericResolution('ajde_events'), resolved.restBase);
  assert.equal(get.endpoint, 'ajde_events');
});

test('concurrent resolutions share one in-flight /types refresh', async () => {
  let served = 0;
  const d = deps({
    listContracts: async () => [],
    request: (async () => {
      served += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return TYPES;
    }) as any
  });
  await resolveContentEndpoint('post', 'site-a', d);
  assert.equal(served, 1);

  const results = await Promise.allSettled(['ghost', 'phantom', 'spectre'].map((type) => resolveContentType(type, 'site-a', d)));
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(served, 2);
});

test('remembers unknown names briefly so repeated misses do not refetch /types', async () => {
  let now = 1_000_000;
  let served = 0;
  const d = deps({
    now: () => now,
    request: (async () => {
      served += 1;
      return TYPES;
    }) as any
  });
  await assert.rejects(() => resolveContentType('ghost', 'site-a', d), /Unknown content type/);
  assert.equal(served, 2);
  await assert.rejects(() => resolveContentType('ghost', 'site-a', d), /Unknown content type/);
  assert.equal(served, 2);

  now += 61 * 1000;
  await assert.rejects(() => resolveContentType('ghost', 'site-a', d), /Unknown content type/);
  assert.equal(served, 3);
});

test('forceRefresh refetches /types and clears remembered unknown names', async () => {
  let served = 0;
  const d = deps({
    request: (async () => {
      served += 1;
      return served >= 3 ? { ...TYPES, ghost: { rest_base: 'ghosts' } } : TYPES;
    }) as any
  });
  await assert.rejects(() => resolveContentType('ghost', 'site-a', d), /Unknown content type/);
  assert.equal(served, 2);
  assert.equal((await resolveContentType('ghost', 'site-a', d, { forceRefresh: true })).restBase, 'ghosts');
  assert.equal(served, 3);
});

test('getSiteTypes shares the resolver cache and refetches on forceRefresh', async () => {
  const d = deps();
  await resolveContentEndpoint('book', 'site-a', d);
  assert.deepEqual(await getSiteTypes('site-a', false, d), TYPES);
  assert.deepEqual(d.calls, ['GET types']);
  await getSiteTypes('site-a', true, d);
  assert.deepEqual(d.calls, ['GET types', 'GET types']);
});
