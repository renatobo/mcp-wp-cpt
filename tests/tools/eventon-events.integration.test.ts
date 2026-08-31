// Integration test: create and update an EventON event through the MCP handler,
// then assert the EventON APIfy read endpoint reports the saved event fields.
// This is opt-in because it creates and deletes a real draft event.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as dotenv from 'dotenv';
import { initWordPress, makeWordPressRequest } from '../../src/wordpress.js';
import { unifiedContentHandlers } from '../../src/tools/unified-content.js';

dotenv.config();

const hasCreds =
  process.env.RUN_EVENTON_INTEGRATION === 'true' &&
  !!process.env.WORDPRESS_API_URL &&
  !!process.env.WORDPRESS_USERNAME &&
  !!process.env.WORDPRESS_PASSWORD;

const EXISTING_LOCATION = {
  term_id: 414,
  name: "Mulleady's Sports Pub & Grill",
  slug: 'mulleadys-sports-pub-grill'
};

const EXISTING_ORGANIZER = {
  term_id: 349,
  name: 'Ducati Riders of Orange County',
  slug: 'ducati-riders-of-orange-county'
};

function parseHandlerJson(result: any) {
  if (result.toolResult.isError) {
    throw new Error(`Handler returned error: ${result.toolResult.content[0]?.text}`);
  }
  return JSON.parse(result.toolResult.content[0].text);
}

function assertPersistedEvent(event: any, subtitle: string, startTime: string) {
  expect(event.start_date).toBe('2026-09-10');
  expect(event.start_time).toBe(startTime);
  expect(event.end_date).toBe('2026-09-10');
  expect(event.end_time).toBe('20:30');
  expect(event.timezone?.key).toBe('America/Los_Angeles');
  expect(event.location?.term_id).toBe(EXISTING_LOCATION.term_id);
  expect(event.location?.slug).toBe(EXISTING_LOCATION.slug);
  expect(event.organizers).toEqual(expect.arrayContaining([expect.objectContaining(EXISTING_ORGANIZER)]));
  expect(event.rsvp?.enabled).toBe(true);
  expect(event.featured_media).toBe(17112);
  expect(event.event_subtitle).toBe(subtitle);
  expect(event.event_excerpt).toBe('A draft event created by the MCP integration test.');
}

describe.skipIf(!hasCreds)('ajde_events EventON persistence (integration)', () => {
  let eventId: number | null = null;

  beforeAll(async () => {
    await initWordPress();
  });

  afterAll(async () => {
    if (eventId !== null) {
      await makeWordPressRequest('DELETE', `events/${eventId}`, undefined, {
        namespace: 'eventonapify/v1'
      });
    }
  });

  it('creates and updates EventON fields through the transactional events API', async () => {
    const title = `mcp-wp EventON integration ${Date.now()}`;
    const fields = {
      start_date: '2026-09-10',
      start_time: '18:30',
      end_date: '2026-09-10',
      end_time: '20:30',
      timezone: { key: 'America/Los_Angeles', text: 'PT' },
      event_subtitle: 'Create persistence check',
      event_excerpt: 'A draft event created by the MCP integration test.',
      event_status: 'scheduled',
      attendance_mode: 'offline',
      location: EXISTING_LOCATION,
      organizers: [EXISTING_ORGANIZER],
      event_color: '#ed1e30',
      flags: {
        generate_gmap: true,
        open_google_maps_link: true
      },
      rsvp: { enabled: true }
    };

    const createResult = await unifiedContentHandlers.create_content({
      content_type: 'ajde_events',
      title,
      status: 'draft',
      featured_media: 17112,
      fields
    } as any);
    const created = parseHandlerJson(createResult);
    expect(typeof created.id).toBe('number');
    eventId = created.id;
    assertPersistedEvent(created, 'Create persistence check', '18:30');

    const readCreated = parseHandlerJson(await unifiedContentHandlers.get_content({
      content_type: 'ajde_events',
      id: eventId
    } as any));
    assertPersistedEvent(readCreated, 'Create persistence check', '18:30');

    const updateResult = await unifiedContentHandlers.update_content({
      content_type: 'ajde_events',
      id: eventId,
      featured_media: 17112,
      fields: {
        ...fields,
        start_time: '19:00',
        event_subtitle: 'Update persistence check'
      }
    } as any);
    const updated = parseHandlerJson(updateResult);
    assertPersistedEvent(updated, 'Update persistence check', '19:00');

    const readUpdated = parseHandlerJson(await unifiedContentHandlers.get_content({
      content_type: 'ajde_events',
      id: eventId
    } as any));
    assertPersistedEvent(readUpdated, 'Update persistence check', '19:00');
  });
});
