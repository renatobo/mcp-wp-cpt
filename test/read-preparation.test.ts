import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContractListRequest,
  buildGetContentRequest,
  buildListContentRequest
} from '../src/content/read-preparation.js';
import { splitNamespacedEndpoint } from '../src/content/utils.js';

test('splitNamespacedEndpoint parses custom plugin namespaces', () => {
  const result = splitNamespacedEndpoint(
    'eventonapify/v1/events/{event_id}/rsvps',
    'event_rsvps'
  );

  assert.equal(result.namespace, 'eventonapify/v1');
  assert.equal(result.endpoint, 'events/{event_id}/rsvps');
});

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

  assert.equal(prepared.endpoint, 'ajde_events');
  assert.equal(prepared.namespace, 'wp/v2');
  assert.deepEqual(prepared.fallbackOn404, {
    endpoint: 'events',
    namespace: 'eventonapify/v1'
  });
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
  assert.equal(prepared.namespace, undefined);
  assert.deepEqual(prepared.queryParams, {
    event_id: 14400,
    per_page: 25
  });
});
