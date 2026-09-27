import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContentDeleteRequest } from '../src/content/write-preparation.js';
import {
  ContractResolution,
  ContentTypeContract,
  ProviderManifest
} from '../src/adapters/types.js';

const manifest: ProviderManifest = {
  provider: 'eventon-apify',
  provider_version: '1.2.0',
  schema_version: '1.0.0',
  namespace: 'eventonapify/v1',
  endpoint: 'mcp-schema',
  source: 'eventonapify/v1/mcp-schema',
  contentTypes: [],
  raw: {}
};

const contract: ContentTypeContract = {
  slug: 'ajde_events',
  preferred_endpoint: 'wp/v2/ajde_events',
  preferred_write_mode: 'fields',
  supported_operations: ['list', 'get', 'create', 'update'],
  fields: [
    {
      name: 'event_subtitle',
      type: 'string'
    }
  ]
};

const contractResolution: ContractResolution = {
  siteId: 'default',
  contentType: 'ajde_events',
  status: 'supported',
  manifest,
  contract,
  issues: [],
  executionSupport: {
    executable: true,
    issues: []
  }
};

test('delete requests for contract-backed EventON events route to APIfy with a wp/v2 fallback', () => {
  const prepared = buildContentDeleteRequest({
    contentType: 'ajde_events',
    id: 123,
    force: true,
    contractResolution
  });

  assert.equal(prepared.endpoint, 'events/123');
  assert.equal(prepared.namespace, 'eventonapify/v1');
  assert.deepEqual(prepared.fallbackOn404, {
    endpoint: 'ajde_events/123',
    namespace: 'wp/v2',
    data: { force: true }
  });
  assert.deepEqual(prepared.data, {});
});
