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

  assert.equal(prepared.endpoint, 'events');
  assert.equal(prepared.namespace, 'eventonapify/v1');
  assert.equal(prepared.fallbackOn404, undefined);
  assert.equal(prepared.data.title, 'Launch Party');
  assert.equal(prepared.data.slug, 'custom-launch-party');
  assert.equal(prepared.data.status, 'draft');
  assert.equal(prepared.data.legacy_flag, true);
  assert.deepEqual(prepared.data.organizers, [{ name: 'Renato' }]);
  assert.deepEqual(prepared.data.virtual, { enabled: true });
  assert.deepEqual(prepared.data.location, { name: 'HQ' });
});

test('contract create requirements accept a documented top-level title without permitting fields.title', () => {
  const titleRequiredContract: ContentTypeContract = {
    ...contract,
    validation_rules: {
      ...contract.validation_rules,
      required_for_create: ['title', 'start_date', 'start_time']
    }
  };

  const prepared = prepareContractWriteRequest(
    {
      title: 'Ride to Big Bear',
      fields: {
        start_date: '2026-04-01',
        start_time: '08:00'
      }
    },
    {
      siteId: 'default',
      contentType: 'ajde_events',
      operation: 'create',
      manifest,
      contract: titleRequiredContract
    }
  );

  assert.equal(prepared.data.title, 'Ride to Big Bear');

  assert.throws(
    () => prepareContractWriteRequest(
      {
        title: 'Ride to Big Bear',
        fields: {
          title: 'Incorrect nested title',
          start_date: '2026-04-01',
          start_time: '08:00'
        }
      },
      {
        siteId: 'default',
        contentType: 'ajde_events',
        operation: 'create',
        manifest,
        contract: titleRequiredContract
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      assert.ok(error.validationIssues.includes('`fields.title` is not defined by the contract.'));
      return true;
    }
  );
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

  assert.equal(itemRequest.endpoint, 'events/123');
  assert.equal(itemRequest.namespace, 'eventonapify/v1');
  assert.equal(itemRequest.data.slug, 'updated-launch-party');
  assert.equal(itemRequest.fallbackOn404, undefined);
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

const eventContext = (contractOverride: ContentTypeContract, operation: 'create' | 'update' = 'create') => ({
  siteId: 'default',
  contentType: 'ajde_events',
  operation,
  manifest,
  contract: contractOverride
});

const timingContract = (validation_rules: Record<string, unknown>, extraFields: ContentTypeContract['fields'] = []): ContentTypeContract => ({
  slug: 'ajde_events',
  preferred_endpoint: 'eventonapify/v1/events',
  preferred_write_mode: 'fields',
  fields: [
    { name: 'start_at', type: 'string' },
    { name: 'start_date', type: 'date' },
    { name: 'end_time', type: 'time' },
    ...(extraFields || [])
  ],
  validation_rules
});

test('one_of_required_for_create applies on create only', () => {
  const oneOf = timingContract({ required_for_create: ['title'], one_of_required_for_create: [['start_date', 'start_at']] });

  assert.doesNotThrow(() => prepareContractWriteRequest({ title: 'A', fields: { start_at: '2026-01-01T10:00:00Z' } }, eventContext(oneOf)));
  assert.doesNotThrow(() => prepareContractWriteRequest({ title: 'A', fields: { start_date: '2026-01-01' } }, eventContext(oneOf)));
  assert.throws(
    () => prepareContractWriteRequest({ title: 'A', fields: { end_time: '10:00' } }, eventContext(oneOf)),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      assert.ok(error.validationIssues.some((entry) => /At least one of `fields.start_date`, `fields.start_at`/.test(entry)));
      return true;
    }
  );
  assert.doesNotThrow(() => prepareContractWriteRequest({ fields: { end_time: '10:00' } }, eventContext(oneOf, 'update')));
});

test('a legacy required start_date is satisfied by start_at', () => {
  const legacy = timingContract({ required_for_create: ['title', 'start_date'] });
  legacy.fields = legacy.fields!.map((field) => field.name === 'start_date' ? { ...field, required_on: ['create'] } : field);

  const prepared = prepareContractWriteRequest({ title: 'A', fields: { start_at: '2026-01-01T10:00:00Z' } }, eventContext(legacy));
  assert.equal(prepared.data.start_at, '2026-01-01T10:00:00Z');
  assert.throws(() => prepareContractWriteRequest({ title: 'A', fields: {} }, eventContext(legacy)), ContractValidationError);
});

test('type arrays, numeric hints, and comma-separated strings are accepted', () => {
  const flexible = timingContract({}, [
    {
      name: 'location',
      type: 'object',
      shape: [
        { name: 'lat', type: 'string', types: ['string', 'number'] },
        { name: 'lon', type: 'string', also_accepts: ['number'] },
        { name: 'name', type: 'string' }
      ]
    },
    { name: 'tags', type: 'array', also_accepts: ['comma_separated_string'], items: { name: 'tag', type: 'string' } },
    { name: 'event_type', type: 'array', items: { name: 'event_type', type: 'string' } }
  ]);

  const prepared = prepareContractWriteRequest(
    { title: 'A', fields: { location: { lat: 34.1, lon: -117.2, name: 'X' }, tags: ' a, b ,, c ' } },
    eventContext(flexible)
  );
  assert.deepEqual(prepared.data.location, { lat: 34.1, lon: -117.2, name: 'X' });
  assert.deepEqual(prepared.data.tags, ['a', 'b', 'c']);

  assert.throws(
    () => prepareContractWriteRequest({ title: 'A', fields: { location: { name: 5 }, event_type: 'x' } }, eventContext(flexible)),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      assert.ok(error.validationIssues.includes('`fields.location.name` must be a string.'));
      assert.ok(error.validationIssues.includes('`fields.event_type` must be an array.'));
      return true;
    }
  );
});
