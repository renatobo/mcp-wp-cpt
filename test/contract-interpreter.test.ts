import test from 'node:test';
import assert from 'node:assert/strict';
import { assessContractExecutionSupport, prepareContractWriteRequest } from '../src/adapters/interpreter.js';
import { attachContentIdToPreparedRequest } from '../src/content/write-preparation.js';
import {
  ContentTypeContract,
  ContractValidationError,
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
  fields: [
    {
      name: 'start_date',
      type: 'string',
      required_on: ['create']
    },
    {
      name: 'start_time',
      type: 'string',
      required_on: ['create']
    },
    {
      name: 'end_date',
      type: 'string'
    },
    {
      name: 'end_time',
      type: 'string'
    },
    {
      name: 'organizers',
      type: 'array',
      coerce: {
        type: 'array_string_to_object_array',
        key: 'name'
      }
    },
    {
      name: 'virtual',
      type: 'boolean',
      coerce: {
        type: 'boolean_to_object',
        key: 'enabled'
      }
    },
    {
      name: 'location',
      type: 'object',
      shape: [
        {
          name: 'name',
          type: 'string'
        }
      ]
    }
  ],
  validation_rules: {
    required_together: [['end_date', 'end_time']]
  }
};

test('contract interpreter reports executable support for a complete contract', () => {
  const support = assessContractExecutionSupport(contract);

  assert.equal(support.executable, true);
  assert.deepEqual(support.issues, []);
});

test('contract interpreter validates and normalizes structured create input', () => {
  const prepared = prepareContractWriteRequest(
    {
      title: 'Launch Party',
      slug: 'custom-launch-party',
      status: 'draft',
      custom_fields: {
        legacy_flag: true
      },
      fields: {
        start_date: '2026-04-01',
        start_time: '18:30',
        end_date: '2026-04-01',
        end_time: '20:30',
        organizers: ['Renato'],
        virtual: true,
        location: {
          name: 'HQ'
        }
      }
    },
    {
      siteId: 'default',
      contentType: 'ajde_events',
      operation: 'create',
      manifest,
      contract
    }
  );

  assert.equal(prepared.endpoint, 'ajde_events');
  assert.equal(prepared.namespace, 'wp/v2');
  assert.deepEqual(prepared.fallbackOn404, {
    endpoint: 'events',
    namespace: 'eventonapify/v1'
  });
  assert.equal(prepared.data.title, 'Launch Party');
  assert.equal(prepared.data.slug, 'custom-launch-party');
  assert.equal(prepared.data.status, 'draft');
  assert.equal(prepared.data.legacy_flag, true);
  assert.deepEqual(prepared.data.organizers, [{ name: 'Renato' }]);
  assert.deepEqual(prepared.data.virtual, { enabled: true });
  assert.deepEqual(prepared.data.location, { name: 'HQ' });
});

test('contract update requests append the content ID to primary and fallback endpoints', () => {
  const prepared = prepareContractWriteRequest(
    {
      title: 'Updated Launch Party',
      slug: 'updated-launch-party',
      fields: {
        end_date: '2026-04-01',
        end_time: '21:00'
      }
    },
    {
      siteId: 'default',
      contentType: 'ajde_events',
      operation: 'update',
      manifest,
      contract
    }
  );

  const itemRequest = attachContentIdToPreparedRequest(prepared, 123);

  assert.equal(itemRequest.endpoint, 'ajde_events/123');
  assert.equal(itemRequest.namespace, 'wp/v2');
  assert.equal(itemRequest.data.slug, 'updated-launch-party');
  assert.deepEqual(itemRequest.fallbackOn404, {
    endpoint: 'events/123',
    namespace: 'eventonapify/v1'
  });
});

test('contract interpreter returns actionable validation errors', () => {
  assert.throws(
    () =>
      prepareContractWriteRequest(
        {
          title: 'Broken Event',
          fields: {
            start_time: '18:30',
            end_date: '2026-04-01',
            unknown_field: true
          }
        },
        {
          siteId: 'default',
          contentType: 'ajde_events',
          operation: 'create',
          manifest,
          contract
        }
      ),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      assert.match(error.message, /invalid/i);
      assert.ok(error.validationIssues.some((entry) => entry.includes('start_date')));
      assert.ok(error.validationIssues.some((entry) => entry.includes('unknown_field')));
      assert.ok(error.validationIssues.some((entry) => entry.includes('provided together')));
      return true;
    }
  );
});
