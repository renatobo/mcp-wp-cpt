import { AdaptedWriteInput } from '../adapters/types.js';

const KEY_FIELDS = [
  'start_date',
  'start_time',
  'end_date',
  'end_time'
] as const;

export class EventONWriteVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventONWriteVerificationError';
  }
}

export function assertEventONWritePersistence(
  input: AdaptedWriteInput,
  event: unknown
): void {
  if (!isRecord(event)) {
    throw new EventONWriteVerificationError('EventON write could not be verified because the read-back response was invalid.');
  }

  const fields = input.fields || {};
  for (const key of KEY_FIELDS) {
    if (fields[key] !== undefined && event[key] !== fields[key]) {
      throw mismatch(key, fields[key], event[key]);
    }
  }

  if (fields.timezone !== undefined) {
    const expectedKey = typeof fields.timezone === 'string'
      ? fields.timezone
      : isRecord(fields.timezone) ? fields.timezone.key : undefined;
    const actualKey = isRecord(event.timezone) ? event.timezone.key : undefined;
    if (expectedKey !== undefined && actualKey !== expectedKey) {
      throw mismatch('timezone.key', expectedKey, actualKey);
    }
  }

  if (isRecord(fields.location)) {
    assertTermPersistence('location', fields.location, event.location);
  }

  if (Array.isArray(fields.organizers)) {
    if (!Array.isArray(event.organizers)) {
      throw mismatch('organizers', fields.organizers, event.organizers);
    }
    for (const expectedOrganizer of fields.organizers) {
      if (!isRecord(expectedOrganizer)) {
        continue;
      }
      const matched = event.organizers.find((entry) =>
        isRecord(entry) && termsMatch(expectedOrganizer, entry)
      );
      if (!matched) {
        throw mismatch('organizers', expectedOrganizer, event.organizers);
      }
    }
  }

  if (isRecord(fields.rsvp) && fields.rsvp.enabled !== undefined) {
    const actualEnabled = isRecord(event.rsvp) ? event.rsvp.enabled : undefined;
    if (actualEnabled !== fields.rsvp.enabled) {
      throw mismatch('rsvp.enabled', fields.rsvp.enabled, actualEnabled);
    }
  }

  const expectedFeaturedMedia = fields.featured_media ?? input.featured_media;
  if (expectedFeaturedMedia !== undefined && event.featured_media !== expectedFeaturedMedia) {
    throw mismatch('featured_media', expectedFeaturedMedia, event.featured_media);
  }
}

function assertTermPersistence(field: string, expected: Record<string, unknown>, actual: unknown): void {
  if (!isRecord(actual) || !termsMatch(expected, actual)) {
    throw mismatch(field, expected, actual);
  }
}

function termsMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  for (const key of ['term_id', 'slug', 'name'] as const) {
    const expectedValue = key === 'name' ? decodeHtmlEntities(expected[key]) : expected[key];
    const actualValue = key === 'name' ? decodeHtmlEntities(actual[key]) : actual[key];
    if (expectedValue !== undefined && actualValue !== expectedValue) {
      return false;
    }
  }
  return true;
}

function decodeHtmlEntities(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'");
}

function mismatch(field: string, expected: unknown, actual: unknown): EventONWriteVerificationError {
  return new EventONWriteVerificationError(
    `EventON write verification failed for ${field}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
