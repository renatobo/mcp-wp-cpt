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

// Raised when the EventON write itself succeeded but the read-back shows the
// requested fields did not persist. Carries the written item so callers can
// report its ID and avoid a duplicate-creating retry.
export class EventONWriteUnverifiedError extends Error {
  readonly written = true;

  constructor(
    readonly operation: 'create' | 'update',
    readonly writeResponse: unknown,
    readonly verificationMessage: string,
    readonly persisted?: unknown
  ) {
    super(`EventON ${operation} was written but not verified: ${verificationMessage}`);
    this.name = 'EventONWriteUnverifiedError';
  }

  get id(): unknown {
    return isRecord(this.writeResponse) ? this.writeResponse.id : undefined;
  }
}

export function formatEventONWriteUnverifiedError(error: EventONWriteUnverifiedError): string {
  const write = isRecord(error.writeResponse) ? error.writeResponse : {};
  const id = error.id;
  const idText = id === undefined ? 'unknown (the write response carried no ID)' : String(id);
  const instructions = error.operation === 'create'
    ? `The event WAS created (id ${idText}). Do NOT call create_content again: that creates a duplicate event. ` +
      `Fix the fields with update_content using content_type "ajde_events" and id ${idText}.`
    : `The update WAS sent to event id ${idText}. Retry the fix with update_content on the same id; do not create a new event.`;

  return JSON.stringify({
    error: 'eventon_write_unverified',
    written: true,
    verified: false,
    operation: error.operation,
    id: id ?? null,
    link: write.link ?? write.permalink ?? null,
    status: write.status ?? null,
    verification_error: error.verificationMessage,
    instructions
  }, null, 2);
}

// True when a write input carries anything the persistence check compares.
export function hasEventONVerifiableInput(input: AdaptedWriteInput): boolean {
  const fields = input.fields || {};
  return Object.keys(fields).length > 0 || input.featured_media !== undefined;
}

// EventON APIfy 3.5.1+ write responses are the persisted format_event payload,
// so they can be verified directly instead of reading the event back.
export function isFullEventONEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === 'number' && typeof value.start_date === 'string';
}

export function assertEventONWritePersistence(
  input: AdaptedWriteInput,
  event: unknown
): void {
  if (!isRecord(event)) {
    throw new EventONWriteVerificationError('EventON write could not be verified because the read-back response was invalid.');
  }

  const fields = input.fields || {};
  // EventON pins the end to the start date at 23:59 when the end time is hidden
  // without spanning (rest-event-validation.php), so requested end values are
  // not what persists in that case.
  const endPinnedByHiddenEnd = isHiddenEndWithoutSpan(fields.flags) || isHiddenEndWithoutSpan(event.flags);

  for (const key of KEY_FIELDS) {
    if (fields[key] === undefined) {
      continue;
    }
    if (endPinnedByHiddenEnd && (key === 'end_date' || key === 'end_time')) {
      continue;
    }

    const isTime = key === 'start_time' || key === 'end_time';
    const expected = isTime ? normalizeTime(fields[key]) : fields[key];
    const actual = isTime ? normalizeTime(event[key]) : event[key];
    if (actual !== expected) {
      throw mismatch(key, fields[key], event[key]);
    }
  }

  if (fields.timezone !== undefined) {
    const expectedKey = typeof fields.timezone === 'string'
      ? fields.timezone
      : isRecord(fields.timezone) ? fields.timezone.key : undefined;
    const actualKey = isRecord(event.timezone) ? event.timezone.key : undefined;
    // An empty key means "leave the timezone unset/unchanged", not a value to match.
    if (typeof expectedKey === 'string' && expectedKey.trim() !== '' && actualKey !== expectedKey.trim()) {
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
  if (expectedFeaturedMedia !== undefined && Number(event.featured_media) !== Number(expectedFeaturedMedia)) {
    throw mismatch('featured_media', expectedFeaturedMedia, event.featured_media);
  }
}

function isHiddenEndWithoutSpan(flags: unknown): boolean {
  return isRecord(flags) && isTruthyFlag(flags.hide_end_time) && !isTruthyFlag(flags.span_hidden_end);
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === 'yes' || value === 'true' || value === '1';
}

// Normalize H:MM, HH:MM, and HH:MM:SS to zero-padded HH:MM.
export function normalizeTime(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const match = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(value);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : value;
}

// Approximates WordPress sanitize_title() for comparing requested and stored
// slugs: lowercase, trim, and collapse anything but letters/digits to hyphens.
export function sanitizeTermSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return String(decodeHtmlEntities(value))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function assertTermPersistence(field: string, expected: Record<string, unknown>, actual: unknown): void {
  if (!isRecord(actual) || !termsMatch(expected, actual)) {
    throw mismatch(field, expected, actual);
  }
}

// A term id is authoritative when requested. Otherwise a matching name or a
// matching sanitized slug is enough: EventON reuses terms by name and may
// store a sanitized or suffixed slug.
function termsMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  if (expected.term_id !== undefined && expected.term_id !== null && expected.term_id !== '') {
    return Number(actual.term_id) === Number(expected.term_id);
  }

  const expectedName = typeof expected.name === 'string' ? String(decodeHtmlEntities(expected.name)).trim() : undefined;
  const expectedSlug = sanitizeTermSlug(expected.slug);
  if (!expectedName && !expectedSlug) {
    return true;
  }

  if (expectedName) {
    const actualName = typeof actual.name === 'string' ? String(decodeHtmlEntities(actual.name)).trim() : undefined;
    if (actualName !== undefined && actualName.toLowerCase() === expectedName.toLowerCase()) {
      return true;
    }
  }

  if (expectedSlug) {
    return sanitizeTermSlug(actual.slug) === expectedSlug;
  }

  return false;
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
