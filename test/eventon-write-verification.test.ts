import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEventONWritePersistence,
  EventONWriteVerificationError
} from '../src/content/eventon-write-verification.js';

const input = {
  title: 'DROC Bike Night',
  featured_media: 17112,
  fields: {
    start_date: '2026-09-10',
    start_time: '18:30',
    end_date: '2026-09-10',
    end_time: '20:30',
    timezone: { key: 'America/Los_Angeles', text: 'PT' },
    location: {
      term_id: 414,
      name: "Mulleady's Sports Pub & Grill",
      slug: 'mulleadys-sports-pub-grill'
    },
    organizers: [{
      term_id: 349,
      name: 'Ducati Riders of Orange County',
      slug: 'ducati-riders-of-orange-county'
    }],
    rsvp: { enabled: true }
  }
};

const persisted = {
  start_date: '2026-09-10',
  start_time: '18:30',
  end_date: '2026-09-10',
  end_time: '20:30',
  timezone: { key: 'America/Los_Angeles', text: 'PT' },
  location: {
    term_id: 414,
    name: "Mulleady's Sports Pub & Grill",
    slug: 'mulleadys-sports-pub-grill'
  },
  organizers: [{
    term_id: 349,
    name: 'Ducati Riders of Orange County',
    slug: 'ducati-riders-of-orange-county'
  }],
  rsvp: { enabled: true },
  featured_media: 17112
};

test('EventON write verification accepts persisted EventON fields and reused terms', () => {
  assert.doesNotThrow(() => assertEventONWritePersistence(input, persisted));
});

test('EventON write verification accepts HTML-encoded term names from EventON read-back', () => {
  assert.doesNotThrow(() => assertEventONWritePersistence(input, {
    ...persisted,
    location: { ...persisted.location, name: "Mulleady's Sports Pub &amp; Grill" }
  }));
});

test('EventON write verification rejects a successful response with discarded fields', () => {
  assert.throws(
    () => assertEventONWritePersistence(input, { ...persisted, start_date: '', organizers: [] }),
    (error: unknown) => {
      assert.ok(error instanceof EventONWriteVerificationError);
      assert.match(error.message, /start_date/);
      return true;
    }
  );
});
