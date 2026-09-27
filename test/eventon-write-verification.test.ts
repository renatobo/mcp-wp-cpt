import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEventONWritePersistence,
  EventONWriteVerificationError,
  normalizeTime,
  sanitizeTermSlug
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

test('EventON write verification normalizes times to zero-padded HH:MM', () => {
  assert.doesNotThrow(() => assertEventONWritePersistence(
    { fields: { start_time: '8:05', end_time: '20:30:00' } },
    { ...persisted, start_time: '08:05', end_time: '20:30' }
  ));
  assert.equal(normalizeTime('7:00'), '07:00');
  assert.equal(normalizeTime('07:00:59'), '07:00');
  assert.equal(normalizeTime('noon'), 'noon');
});

test('EventON write verification skips end checks when the end time is hidden without spanning', () => {
  const hiddenEnd = { fields: { start_date: '2026-09-10', end_date: '2026-09-12', end_time: '20:30', flags: { hide_end_time: true } } };
  const pinned = { ...persisted, end_date: '2026-09-10', end_time: '23:59', flags: { hide_end_time: true, span_hidden_end: false } };
  assert.doesNotThrow(() => assertEventONWritePersistence(hiddenEnd, pinned));

  const spanning = { fields: { ...hiddenEnd.fields, flags: { hide_end_time: true, span_hidden_end: true } } };
  assert.throws(
    () => assertEventONWritePersistence(spanning, { ...pinned, flags: { hide_end_time: true, span_hidden_end: true } }),
    /end_date/
  );
});

test('EventON write verification prefers term_id and compares slugs sanitized', () => {
  assert.doesNotThrow(() => assertEventONWritePersistence(
    { fields: { location: { term_id: 414, name: 'Old name' } } },
    persisted
  ));
  assert.throws(
    () => assertEventONWritePersistence({ fields: { location: { term_id: 999 } } }, persisted),
    /location/
  );
  assert.doesNotThrow(() => assertEventONWritePersistence(
    { fields: { organizers: [{ slug: ' Ducati Riders of Orange County ' }] } },
    persisted
  ));
  assert.equal(sanitizeTermSlug("Mulleady's Sports Pub & Grill"), 'mulleadys-sports-pub-grill');
});

test('EventON write verification ignores an empty timezone', () => {
  assert.doesNotThrow(() => assertEventONWritePersistence(
    { fields: { timezone: '' } },
    { ...persisted, timezone: { key: 'UTC', text: '' } }
  ));
  assert.doesNotThrow(() => assertEventONWritePersistence(
    { fields: { timezone: { key: '' } } },
    persisted
  ));
});
