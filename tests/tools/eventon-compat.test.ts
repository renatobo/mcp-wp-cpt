import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/wordpress.js', () => ({
  makeWordPressRequest: vi.fn(),
  logToFile: vi.fn()
}));

vi.mock('../../src/config/site-manager.js', () => ({
  getRequestTimeoutMs: () => 30000,
  siteManager: {
    resolveSiteId: (siteId?: string) => siteId || 'default',
    getAllSites: () => [{ id: 'default', url: 'https://example.com' }]
  }
}));

import { makeWordPressRequest } from '../../src/wordpress.js';
import { unifiedContentHandlers } from '../../src/tools/unified-content.js';
import { clearContentTypeCache } from '../../src/content/content-types.js';
import { clearManifestCache } from '../../src/adapters/manifest-loader.js';

const requestMock = vi.mocked(makeWordPressRequest);

const timingFields = [
  { name: 'start_at', type: 'string', operations: ['create', 'update'] },
  { name: 'start_date', type: 'date', operations: ['create', 'update'] },
  { name: 'start_time', type: 'time', operations: ['create', 'update'] },
  { name: 'end_at', type: 'string', operations: ['create', 'update'] },
  { name: 'end_date', type: 'date', operations: ['create', 'update'] },
  { name: 'end_time', type: 'time', operations: ['create', 'update'] },
  {
    name: 'timezone',
    type: 'object',
    coerce: { type: 'string_to_object', key: 'key' },
    shape: [{ name: 'key', type: 'string' }, { name: 'text', type: 'string' }]
  },
  {
    name: 'flags',
    type: 'object',
    shape: [{ name: 'hide_end_time', type: 'boolean' }, { name: 'span_hidden_end', type: 'boolean' }]
  },
  {
    name: 'organizers',
    type: 'array',
    coerce: { type: 'array_string_to_object_array', key: 'name' },
    items: {
      name: 'organizer',
      type: 'object',
      shape: [{ name: 'term_id', type: 'integer' }, { name: 'name', type: 'string' }, { name: 'slug', type: 'string' }]
    }
  }
];

// Shape of the EventON APIfy 3.5.1 manifest.
const OLD_MANIFEST = {
  schema_version: '1.0.0',
  provider: 'eventon-apify',
  provider_version: '3.5.1',
  content_types: [
    {
      slug: 'ajde_events',
      preferred_endpoint: 'wp/v2/ajde_events',
      read_endpoint: 'eventonapify/v1/events',
      preferred_write_mode: 'fields',
      supported_operations: ['list', 'get', 'create', 'update'],
      fields: [
        ...timingFields.map((field) => field.name === 'start_date' ? { ...field, required_on: ['create'] } : field),
        { name: 'tags', type: 'array', items: { name: 'tag', type: 'string' } },
        { name: 'event_type', type: 'array', items: { name: 'event_type', type: 'string' } },
        {
          name: 'location',
          type: 'object',
          coerce: { type: 'string_to_object', key: 'name' },
          shape: [
            { name: 'name', type: 'string' },
            { name: 'lat', type: 'string' },
            { name: 'lon', type: 'string' }
          ]
        },
        {
          name: 'repeat',
          type: 'object',
          shape: [
            { name: 'enabled', type: 'boolean' },
            {
              name: 'intervals',
              type: 'array',
              items: {
                name: 'repeat_interval',
                type: 'object',
                shape: [{ name: 'start_at', type: 'string' }, { name: 'end_at', type: 'string' }]
              }
            }
          ]
        }
      ],
      validation_rules: {
        required_for_create: ['title', 'start_date'],
        required_for_update: [],
        required_together: [],
        one_of_required: []
      }
    },
    {
      slug: 'event_rsvps',
      preferred_endpoint: 'eventonapify/v1/events/{event_id}/rsvps',
      preferred_write_mode: 'read_only',
      supported_operations: ['list'],
      parent_context: { content_type: 'ajde_events', id_param: 'event_id' }
    }
  ]
};

// Shape of the updated manifest (preferred_endpoint on APIfy, one-of start rule).
const NEW_MANIFEST = {
  ...OLD_MANIFEST,
  provider_version: '3.6.0',
  content_types: [
    {
      ...OLD_MANIFEST.content_types[0],
      preferred_endpoint: 'eventonapify/v1/events',
      related_endpoints: [
        { name: 'item', endpoint: 'eventonapify/v1/events/{id}' },
        { name: 'wp_v2_compat', endpoint: 'wp/v2/ajde_events' }
      ],
      supported_operations: ['list', 'get', 'create', 'update', 'delete'],
      fields: [
        ...timingFields,
        { name: 'tags', type: 'array', also_accepts: ['comma_separated_string'], items: { name: 'tag', type: 'string' } },
        { name: 'event_type', type: 'array', also_accepts: ['comma_separated_string'], items: { name: 'event_type', type: 'string' } },
        {
          name: 'location',
          type: 'object',
          coerce: { type: 'string_to_object', key: 'name' },
          shape: [
            { name: 'name', type: 'string' },
            { name: 'lat', type: ['string', 'number'] },
            { name: 'lon', type: ['string', 'number'] }
          ]
        },
        {
          name: 'repeat',
          type: 'object',
          shape: [
            { name: 'enabled', type: 'boolean' },
            {
              name: 'intervals',
              type: 'array',
              items: {
                name: 'repeat_interval',
                type: 'object',
                shape: [
                  { name: 'start_at', type: 'string' },
                  { name: 'end_at', type: 'string' },
                  { name: 'start_timestamp', type: 'integer' },
                  { name: 'end_timestamp', type: 'integer' },
                  { name: 'start_date', type: 'string' },
                  { name: 'start_time', type: 'string' },
                  { name: 'end_date', type: 'string' },
                  { name: 'end_time', type: 'string' }
                ]
              }
            }
          ]
        }
      ],
      validation_rules: {
        required_for_create: ['title'],
        one_of_required_for_create: [['start_date', 'start_at']]
      }
    },
    OLD_MANIFEST.content_types[1]
  ]
};

const TYPES = {
  post: { rest_base: 'posts' },
  ajde_events: { rest_base: 'ajde_events' }
};

function persistedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    title: 'Bike Night',
    status: 'draft',
    slug: 'bike-night',
    description: '<p>Meet at the pub.</p>',
    start_date: '2026-10-01',
    start_time: '18:30',
    end_date: '2026-10-01',
    end_time: '21:00',
    timezone: { key: 'America/Los_Angeles', text: '' },
    event_status: 'scheduled',
    location: { term_id: 4, name: 'Garage', slug: 'garage', phone: '555', email: 'a@b.c', city: 'Irvine' },
    organizers: [{ term_id: 9, name: 'DROC', slug: 'droc', email: 'x@y.z' }],
    flags: { hide_end_time: false, span_hidden_end: false },
    featured_media: 0,
    ...overrides
  };
}

type Call = { method: string; endpoint: string; data: any; options: any };

function installMock(manifest: unknown, handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  requestMock.mockImplementation(async (method: string, endpoint: string, data?: any, options?: any) => {
    const call = { method, endpoint, data, options };
    calls.push(call);
    if (endpoint === 'types') return TYPES;
    if (endpoint === 'mcp-schema') {
      if (manifest instanceof Error) throw manifest;
      return manifest;
    }
    return handler(call);
  });
  return calls;
}

function parse(result: any) {
  return JSON.parse(result.toolResult.content[result.toolResult.content.length - 1].text);
}

beforeEach(() => {
  requestMock.mockReset();
  clearContentTypeCache();
  clearManifestCache();
});

describe.each([
  ['3.5.1 manifest', OLD_MANIFEST],
  ['updated manifest', NEW_MANIFEST]
])('EventON routing with the %s', (_label, manifest) => {
  it('lists events without client-side filtering and passes envelope totals through', async () => {
    const envelope = {
      total: 42,
      pages: 5,
      page: 2,
      per_page: 10,
      // Deliberately out of the requested range and order: the server is trusted.
      events: [persistedEvent({ id: 2, start_date: '2025-01-01' }), persistedEvent({ id: 1, start_date: '2030-01-01' })]
    };
    const calls = installMock(manifest, () => envelope);

    const result = await unifiedContentHandlers.list_content({
      content_type: 'ajde_events',
      after: '2026-01-01',
      before: '2027-01-01',
      orderby: 'date',
      page: 2
    } as any);
    const body = parse(result);

    const listCall = calls.find((call) => call.endpoint === 'events')!;
    expect(listCall.options.namespace).toBe('eventonapify/v1');
    expect(listCall.data).toEqual({ starts_on_or_after: '2026-01-01', starts_before: '2027-01-01', orderby: 'created', page: 2 });
    expect(listCall.options.retry404With).toMatchObject({
      endpoint: 'ajde_events',
      namespace: 'wp/v2',
      on403Codes: ['eventon_apify_disabled', 'eventon_apify_capability_disabled'],
      data: { after: '2026-01-01', before: '2027-01-01', orderby: 'date', page: 2 }
    });
    expect(body.total).toBe(42);
    expect(body.pages).toBe(5);
    expect(body.page).toBe(2);
    expect(body.per_page).toBe(10);
    expect(body.events.map((event: any) => event.id)).toEqual([2, 1]);
    expect(body._mcp_warnings).toBeUndefined();
  });

  it('warns about list params eventonapify/v1/events ignores', async () => {
    const calls = installMock(manifest, () => ({ total: 0, pages: 0, page: 1, per_page: 10, events: [] }));

    const result = await unifiedContentHandlers.list_content({
      content_type: 'ajde_events',
      categories: [3],
      tags: [7],
      author: 1,
      parent: 2,
      orderby: 'relevance'
    } as any);
    const body = parse(result);

    const listCall = calls.find((call) => call.endpoint === 'events')!;
    expect(listCall.data).toEqual({});
    expect(listCall.options.retry404With.data).toEqual({ categories: [3], tags: [7], author: 1, parent: 2 });
    expect(body._mcp_warnings).toHaveLength(2);
    expect(body._mcp_warnings[0]).toMatch(/orderby "relevance"/);
    expect(body._mcp_warnings[1]).toMatch(/categories, tags, author, parent/);
  });

  it('projects EventON list items by their own shape', async () => {
    installMock(manifest, () => ({ total: 1, pages: 1, page: 1, per_page: 10, events: [persistedEvent()] }));

    const body = parse(await unifiedContentHandlers.list_content({ content_type: 'ajde_events' } as any));
    const [event] = body.events;
    expect(event.location).toEqual({ term_id: 4, name: 'Garage', slug: 'garage', city: 'Irvine' });
    expect(event.organizers).toEqual([{ term_id: 9, name: 'DROC', slug: 'droc' }]);
    expect(event.description).toBeUndefined();
    expect(event.start_date).toBe('2026-10-01');
    expect('type' in event || 'author' in event || 'date' in event).toBe(false);
  });

  it('exposes the APIfy description as content_raw and edits it through content', async () => {
    const calls = installMock(manifest, (call) => {
      if (call.method === 'GET' && call.endpoint === 'events/501') return persistedEvent();
      if (call.method === 'POST') return persistedEvent({ description: call.data.content });
      return undefined;
    });

    const got = parse(await unifiedContentHandlers.get_content({
      content_type: 'ajde_events',
      id: 501,
      include_raw_content: true
    } as any));
    expect(got.content_raw).toBe('<p>Meet at the pub.</p>');

    const updated = await unifiedContentHandlers.update_content({
      content_type: 'ajde_events',
      id: 501,
      content_edit: { operation: 'replace', target_text: 'the pub', value: 'the garage', content_format: 'html' }
    } as any);
    expect(updated.toolResult.isError).toBe(false);
    const write = calls.find((call) => call.method === 'POST')!;
    expect(write.endpoint).toBe('events/501');
    expect(write.options.namespace).toBe('eventonapify/v1');
    expect(write.data.content).toBe('<p>Meet at the garage.</p>');
  });

  it('verifies a create against the full write response without a read-back', async () => {
    const calls = installMock(manifest, (call) => {
      if (call.method === 'POST') {
        return persistedEvent({ start_time: '06:30', end_date: '2026-10-01', end_time: '23:59', flags: { hide_end_time: true, span_hidden_end: false } });
      }
      throw new Error(`unexpected ${call.method} ${call.endpoint}`);
    });

    const result = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title: 'Bike Night',
      status: 'draft',
      fields: {
        start_date: '2026-10-01',
        start_time: '6:30',
        end_date: '2026-10-02',
        end_time: '20:00:00',
        timezone: '',
        flags: { hide_end_time: true },
        location: { name: 'garage' },
        organizers: [{ slug: 'DROC ' }]
      }
    } as any);

    expect(result.toolResult.isError).toBe(false);
    expect(calls.filter((call) => call.method === 'GET' && call.endpoint.startsWith('events/'))).toHaveLength(0);
    expect(parse(result)._mcp_warnings).toBeUndefined();
  });

  it('accepts start_at in place of start_date on create', async () => {
    const calls = installMock(manifest, (call) => call.method === 'POST' ? persistedEvent() : undefined);

    const result = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title: 'Bike Night',
      fields: { start_at: '2026-10-01T18:30:00-07:00' }
    } as any);

    expect(result.toolResult.isError).toBe(false);
    expect(calls.find((call) => call.method === 'POST')!.data.start_at).toBe('2026-10-01T18:30:00-07:00');
  });

  it('still requires a start date or datetime on create', async () => {
    installMock(manifest, () => persistedEvent());

    const result = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title: 'Bike Night',
      fields: { start_time: '18:30' }
    } as any);

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toMatch(/start_date/);
  });

  it('refuses writes to the read-only RSVP contract instead of sending a template path', async () => {
    const calls = installMock(manifest, () => ({}));

    const result = await unifiedContentHandlers.create_content({
      content_type: 'event_rsvps',
      title: 'x'
    } as any);
    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toMatch(/read-only/);

    const got = await unifiedContentHandlers.get_content({ content_type: 'event_rsvps', id: 3 } as any);
    expect(got.toolResult.isError).toBe(true);
    expect(got.toolResult.content[0].text).toMatch(/does not support single-item reads/);
    expect(calls.some((call) => call.endpoint.includes('{'))).toBe(false);
  });

  it('deletes events through APIfy and notes that force is not applied', async () => {
    const calls = installMock(manifest, (call) =>
      call.method === 'DELETE' ? { deleted: true, id: 501, title: 'Bike Night' } : undefined
    );

    const body = parse(await unifiedContentHandlers.delete_content({ content_type: 'ajde_events', id: 501, force: true } as any));

    const del = calls.find((call) => call.method === 'DELETE')!;
    expect(del.endpoint).toBe('events/501');
    expect(del.options.namespace).toBe('eventonapify/v1');
    expect(del.options.retry404With).toEqual({ endpoint: 'ajde_events/501', namespace: 'wp/v2', data: { force: true } });
    expect(body._mcp_warnings[0]).toMatch(/trash/);
  });
});

describe('EventON interpreter compatibility with the updated manifest', () => {
  it('accepts numeric coordinates, comma-separated terms, and extra interval keys', async () => {
    const calls = installMock(NEW_MANIFEST, (call) => call.method === 'POST' ? persistedEvent() : undefined);

    const result = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title: 'Bike Night',
      fields: {
        start_date: '2026-10-01',
        location: { name: 'Garage', lat: 34.2439, lon: '-116.9114' },
        tags: 'bikes, night , ,ducati',
        event_type: 'Ride',
        repeat: {
          enabled: true,
          intervals: [
            { start_timestamp: 1790000000, end_timestamp: 1790003600 },
            [1790086400, 1790090000]
          ]
        }
      }
    } as any);

    expect(result.toolResult.isError).toBe(false);
    const payload = calls.find((call) => call.method === 'POST')!.data;
    expect(payload.location).toEqual({ name: 'Garage', lat: 34.2439, lon: '-116.9114' });
    expect(payload.tags).toEqual(['bikes', 'night', 'ducati']);
    expect(payload.event_type).toEqual(['Ride']);
    expect(payload.repeat.intervals).toEqual([
      { start_timestamp: 1790000000, end_timestamp: 1790003600 },
      [1790086400, 1790090000]
    ]);
  });

  it('keeps undeclared interval keys and rejects numeric coordinates on the 3.5.1 manifest', async () => {
    const calls = installMock(OLD_MANIFEST, (call) => call.method === 'POST' ? persistedEvent() : undefined);

    const ok = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title: 'Bike Night',
      fields: { start_date: '2026-10-01', repeat: { intervals: [{ start_timestamp: 1, end_timestamp: 2 }] } }
    } as any);
    expect(ok.toolResult.isError).toBe(false);
    expect(calls.find((call) => call.method === 'POST')!.data.repeat.intervals).toEqual([{ start_timestamp: 1, end_timestamp: 2 }]);

    const rejected = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title: 'Bike Night',
      fields: { start_date: '2026-10-01', location: { name: 'Garage', lat: 34.2 } }
    } as any);
    expect(rejected.toolResult.isError).toBe(true);
    expect(rejected.toolResult.content[0].text).toMatch(/location\.lat/);
  });
});

describe('EventON fallback when the APIfy API is disabled', () => {
  it('reports a disabled manifest and keeps reads on the wp/v2 fallback', async () => {
    const disabled = Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      response: { status: 403, data: { code: 'eventon_apify_disabled', message: 'disabled' } }
    });
    const calls = installMock(disabled, () => ({ total: 0, pages: 0, page: 1, per_page: 10, events: [] }));

    const described = parse(await unifiedContentHandlers.describe_content_type({ content_type: 'ajde_events' } as any));
    expect(described.contract.status).toBe('manifest_disabled');
    expect(described.contract.message).toMatch(/API is disabled/);

    await unifiedContentHandlers.list_content({ content_type: 'ajde_events' } as any);
    const listCall = calls.find((call) => call.endpoint === 'events')!;
    expect(listCall.options.retry404With.on403Codes).toContain('eventon_apify_disabled');

    const write = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title: 'x',
      fields: { start_date: '2026-10-01' }
    } as any);
    expect(write.toolResult.isError).toBe(true);
    expect(write.toolResult.content[0].text).toMatch(/API is disabled/);
  });

  it('does not add a verification warning on the no-manifest wp/v2 write path', async () => {
    const missing = Object.assign(new Error('Request failed with status code 404'), {
      isAxiosError: true,
      response: { status: 404, data: { code: 'rest_no_route' } }
    });
    const calls = installMock(missing, (call) =>
      call.method === 'POST' ? { id: 77, status: 'draft', featured_media: 12, title: { rendered: 'x' } } : undefined
    );

    const result = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title: 'x',
      featured_media: 12
    } as any);

    expect(result.toolResult.isError).toBe(false);
    expect(parse(result)._mcp_warnings).toBeUndefined();
    expect(calls.find((call) => call.method === 'POST')!.endpoint).toBe('ajde_events');
    expect(calls.some((call) => call.method === 'GET' && call.endpoint === 'events/77')).toBe(false);
  });
});
