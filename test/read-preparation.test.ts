import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContractListRequest,
  buildGetContentRequest,
  buildListContentRequest
} from '../src/content/read-preparation.js';
import {
  extractContentCollection,
  findItemBySlug,
  splitNamespacedEndpoint
} from '../src/content/utils.js';

test('extractContentCollection normalizes array and enveloped list responses', () => {
  assert.deepEqual(extractContentCollection([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(
    extractContentCollection({ events: [{ id: 2 }], total: 1 }),
    [{ id: 2 }]
  );
  assert.deepEqual(extractContentCollection({ items: [{ id: 3 }] }), [{ id: 3 }]);
  assert.deepEqual(extractContentCollection({ nothing: true }), []);
  assert.deepEqual(extractContentCollection(null), []);
});

test('findItemBySlug matches slug, post_name, and trailing link segment', () => {
  const items = [
    { id: 1, slug: 'other-event' },
    { id: 2, post_name: 'gala-night' },
    { id: 3, link: 'https://site.com/events/california-clubs-week-2026/' }
  ];

  assert.equal(findItemBySlug(items, 'gala-night')?.id, 2);
  assert.equal(findItemBySlug(items, 'california-clubs-week-2026')?.id, 3);
  assert.equal(findItemBySlug(items, 'missing'), undefined);
});

test('splitNamespacedEndpoint parses custom plugin namespaces', () => {
  const result = splitNamespacedEndpoint(
    'eventonapify/v1/events/{event_id}/rsvps',
    'event_rsvps'
  );

  assert.equal(result.namespace, 'eventonapify/v1');
  assert.equal(result.endpoint, 'events/{event_id}/rsvps');
});

const DISABLED_CODES = ['eventon_apify_disabled', 'eventon_apify_capability_disabled'];

// wp/v2 fallback params for the shared EventON list input below: after/before
// and a WordPress orderby pass through untouched (publish-date semantics).
const WP_V2_FALLBACK_LIST_PARAMS = {
  after: '2025-12-31',
  before: '2027-01-01',
  per_page: 100,
  order: 'asc',
  orderby: 'date'
};

function getEventRsvpResolution(overrides: Record<string, unknown> = {}) {
  return {
    siteId: 'staging',
    contentType: 'event_rsvps',
    status: 'supported',
    contract: {
      slug: 'event_rsvps',
      preferred_endpoint: 'eventonapify/v1/events/{event_id}/rsvps',
      preferred_write_mode: 'read_only',
      supported_operations: ['list'],
      parent_context: {
        content_type: 'ajde_events',
        id_param: 'event_id'
      }
    },
    manifest: {
      provider: 'eventon-apify',
      schema_version: '1.0.0',
      namespace: 'eventonapify/v1',
      endpoint: 'mcp-schema',
      source: 'eventonapify/v1/mcp-schema',
      contentTypes: [],
      raw: {}
    },
    issues: [],
    executionSupport: {
      executable: true,
      issues: []
    },
    ...overrides
  } as const;
}

function getEventResolution(overrides: Record<string, unknown> = {}) {
  return {
    siteId: 'staging',
    contentType: 'ajde_events',
    status: 'supported',
    contract: {
      slug: 'ajde_events',
      preferred_endpoint: 'wp/v2/ajde_events',
      preferred_write_mode: 'fields',
      supported_operations: ['list', 'create', 'update']
    },
    manifest: {
      provider: 'eventon-apify',
      schema_version: '1.0.0',
      namespace: 'eventonapify/v1',
      endpoint: 'mcp-schema',
      source: 'eventonapify/v1/mcp-schema',
      contentTypes: [],
      raw: {}
    },
    issues: [],
    executionSupport: {
      executable: true,
      issues: []
    },
    ...overrides
  } as const;
}

test('buildContractListRequest resolves contract-backed nested list endpoints', () => {
  const queryParams = {
    event_id: 14400,
    per_page: 25,
    rsvp: 'yes'
  };
  const prepared = buildContractListRequest(queryParams, getEventRsvpResolution());

  assert.equal(prepared.endpoint, 'events/14400/rsvps');
  assert.equal(prepared.namespace, 'eventonapify/v1');
  assert.deepEqual(prepared.queryParams, {
    per_page: 25,
    rsvp: 'yes'
  });
});

test('buildGetContentRequest uses contract routes for direct content reads', () => {
  const prepared = buildGetContentRequest(getEventResolution());

  assert.equal(prepared.endpoint, 'events');
  assert.equal(prepared.namespace, 'eventonapify/v1');
  assert.deepEqual(prepared.fallbackOn404, {
    endpoint: 'ajde_events',
    namespace: 'wp/v2',
    on403Codes: DISABLED_CODES
  });
});

test('buildContractListRequest prefers the EventON read endpoint for ajde_events', () => {
  const prepared = buildContractListRequest(
    {
      after: '2025-12-31',
      before: '2027-01-01',
      per_page: 100,
      order: 'asc',
      orderby: 'date'
    },
    getEventResolution()
  );

  assert.equal(prepared.endpoint, 'events');
  assert.equal(prepared.namespace, 'eventonapify/v1');
  assert.deepEqual(prepared.fallbackOn404, {
    endpoint: 'ajde_events',
    namespace: 'wp/v2',
    on403Codes: DISABLED_CODES,
    data: WP_V2_FALLBACK_LIST_PARAMS
  });
  assert.deepEqual(prepared.queryParams, {
    starts_on_or_after: '2025-12-31',
    starts_before: '2027-01-01',
    per_page: 100,
    order: 'asc',
    orderby: 'created'
  });
  assert.equal((prepared as any).responseFilter, undefined);
  assert.equal(prepared.warnings, undefined);
});

test('buildListContentRequest uses contract list routes even when write support is incomplete', () => {
  const prepared = buildListContentRequest(
    {
      event_id: 14400,
      per_page: 25,
      rsvp: 'yes'
    },
    getEventRsvpResolution({
      status: 'contract_incomplete',
      executionSupport: {
        executable: false,
        issues: ['Field-driven contracts must define `fields`.']
      }
    })
  );

  assert.equal(prepared.endpoint, 'events/14400/rsvps');
  assert.equal(prepared.namespace, 'eventonapify/v1');
  assert.deepEqual(prepared.queryParams, {
    per_page: 25,
    rsvp: 'yes'
  });
});

test('buildContractListRequest requires parent context parameters for nested contracts', () => {
  assert.throws(
    () =>
      buildContractListRequest(
        {
          per_page: 25
        },
        getEventRsvpResolution()
      ),
    (error: any) => {
      assert.equal(error.code, 'contract_compatibility_error');
      assert.match(error.message, /requires the `event_id` parameter/);
      return true;
    }
  );
});

test('buildListContentRequest still requires parent context parameters for incomplete contracts', () => {
  assert.throws(
    () =>
      buildListContentRequest(
        {
          per_page: 25
        },
        getEventRsvpResolution({
          status: 'contract_incomplete',
          executionSupport: {
            executable: false,
            issues: ['Field-driven contracts must define `fields`.']
          }
        })
      ),
    (error: any) => {
      assert.equal(error.code, 'contract_compatibility_error');
      assert.match(error.message, /requires the `event_id` parameter/);
      return true;
    }
  );
});

test('buildListContentRequest falls back to the generic endpoint when list is unsupported', () => {
  const prepared = buildListContentRequest(
    {
      event_id: 14400,
      per_page: 25
    },
    getEventRsvpResolution({
      status: 'contract_incomplete',
      contract: {
        ...getEventRsvpResolution().contract,
        supported_operations: ['create', 'update']
      },
      executionSupport: {
        executable: false,
        issues: ['Field-driven contracts must define `fields`.']
      }
    })
  );

  assert.equal(prepared.endpoint, 'event_rsvps');
  assert.equal(prepared.namespace, 'wp/v2');
  assert.deepEqual(prepared.queryParams, {
    event_id: 14400,
    per_page: 25
  });
});

test('buildListContentRequest gives EventON lists start-date semantics with no resolved contract', () => {
  const prepared = buildListContentRequest(
    {
      after: '2025-12-31',
      before: '2027-01-01',
      per_page: 100,
      order: 'asc',
      orderby: 'date'
    },
    {
      siteId: 'staging',
      contentType: 'ajde_events',
      status: 'unresolved',
      contract: undefined,
      manifest: undefined,
      issues: [],
      executionSupport: { executable: false, issues: [] }
    } as any
  );

  assert.equal(prepared.endpoint, 'events');
  assert.equal(prepared.namespace, 'eventonapify/v1');
  assert.deepEqual(prepared.fallbackOn404, {
    endpoint: 'ajde_events',
    namespace: 'wp/v2',
    on403Codes: DISABLED_CODES,
    data: WP_V2_FALLBACK_LIST_PARAMS
  });
  assert.deepEqual(prepared.queryParams, {
    starts_on_or_after: '2025-12-31',
    starts_before: '2027-01-01',
    per_page: 100,
    order: 'asc',
    orderby: 'created'
  });
  assert.equal((prepared as any).responseFilter, undefined);
  assert.equal(prepared.warnings, undefined);
});

test('buildListContentRequest still uses direct EventON reads when list support is omitted', () => {
  const prepared = buildListContentRequest(
    {
      after: '2025-12-31',
      before: '2027-01-01',
      per_page: 100,
      order: 'asc',
      orderby: 'date'
    },
    getEventResolution({
      contract: {
        ...getEventResolution().contract,
        supported_operations: ['create', 'update']
      }
    })
  );

  assert.equal(prepared.endpoint, 'events');
  assert.equal(prepared.namespace, 'eventonapify/v1');
  assert.deepEqual(prepared.queryParams, {
    starts_on_or_after: '2025-12-31',
    starts_before: '2027-01-01',
    per_page: 100,
    order: 'asc',
    orderby: 'created'
  });
  assert.equal((prepared as any).responseFilter, undefined);
  assert.equal(prepared.warnings, undefined);
});

test('EventON reads from an eventonapify/v1/events preferred endpoint keep the wp/v2 fallback', () => {
  const resolution = getEventResolution({
    contract: {
      ...getEventResolution().contract,
      preferred_endpoint: 'eventonapify/v1/events',
      related_endpoints: [{ name: 'item', endpoint: 'eventonapify/v1/events/{id}' }],
      supported_operations: ['list', 'get', 'create', 'update', 'delete']
    }
  });

  const get = buildGetContentRequest(resolution);
  assert.equal(get.endpoint, 'events');
  assert.equal(get.namespace, 'eventonapify/v1');
  assert.deepEqual(get.fallbackOn404, { endpoint: 'ajde_events', namespace: 'wp/v2', on403Codes: DISABLED_CODES });

  const list = buildListContentRequest({ upcoming: true, orderby: 'title' }, resolution);
  assert.equal(list.endpoint, 'events');
  assert.deepEqual(list.queryParams, { upcoming: true, orderby: 'title' });
  assert.deepEqual(list.fallbackOn404, {
    endpoint: 'ajde_events',
    namespace: 'wp/v2',
    on403Codes: DISABLED_CODES,
    data: { orderby: 'title' }
  });
});

test('EventON lists drop and warn about params the APIfy endpoint ignores', () => {
  const prepared = buildListContentRequest(
    { categories: [3], tags: [4], author: 2, per_page: 5, orderby: 'start_at', search: 'bike' },
    getEventResolution()
  );

  assert.deepEqual(prepared.queryParams, { per_page: 5, orderby: 'start_at', search: 'bike' });
  assert.equal(prepared.warnings?.length, 1);
  assert.match(prepared.warnings![0], /categories, tags, author/);
  // wp/v2 has no start_at order; the fallback keeps the native filters.
  assert.deepEqual(prepared.fallbackOn404?.data, { categories: [3], tags: [4], author: 2, per_page: 5, search: 'bike' });
});

test('EventON lists accept filters a manifest read_contract publishes', () => {
  const prepared = buildListContentRequest(
    { venue: 'garage' },
    getEventResolution({
      contract: { ...getEventResolution().contract, read_contract: { filters: { venue: {} } } }
    })
  );

  assert.deepEqual(prepared.queryParams, { venue: 'garage' });
  assert.equal(prepared.warnings, undefined);
});

test('buildGetContentRequest refuses item reads on list-only nested contracts', () => {
  assert.throws(
    () => buildGetContentRequest(getEventRsvpResolution()),
    (error: any) => {
      assert.equal(error.code, 'contract_compatibility_error');
      assert.match(error.message, /does not support single-item reads/);
      return true;
    }
  );
});

test('extractContentCollection reads the RSVP attendees envelope', () => {
  assert.deepEqual(extractContentCollection({ attendees: [{ id: 9 }], total: 1 }), [{ id: 9 }]);
});
