// src/content/projection.ts
// Client-side response projection for content reads. Applied after the
// response arrives instead of sending WordPress `_fields`, because plugin
// endpoints return envelopes (e.g. EventON `{ events: [...], total, pages }`)
// and `_fields` would filter the envelope keys rather than the items.

export type ContentFieldsSelection = 'full' | string[];

// Compact per-item keys for wp/v2 list results.
export const DEFAULT_LIST_ITEM_FIELDS = [
  'id',
  'slug',
  'type',
  'status',
  'date',
  'modified',
  'link',
  'title',
  'excerpt',
  'author',
  'featured_media',
  'parent',
  'menu_order',
  'categories',
  'tags'
] as const;

// Compact per-item keys for EventON APIfy events (eventonapify/v1/events),
// which have their own shape: no type/date/author, start/end fields instead.
export const EVENTON_EVENT_LIST_FIELDS = [
  'id',
  'title',
  'status',
  'slug',
  'link',
  'excerpt',
  'event_excerpt',
  'event_subtitle',
  'start_at',
  'start_date',
  'start_time',
  'end_at',
  'end_date',
  'end_time',
  'timezone',
  'event_status',
  'attendance_mode',
  'event_type',
  'tags',
  'location',
  'organizers',
  'repeat',
  'flags',
  'time_extend_type',
  'created',
  'modified',
  'featured_media'
] as const;

// Location and organizer terms are reduced to identifiers plus a short place
// hint; contact details and descriptions stay available through fields: 'full'.
const EVENTON_LOCATION_KEYS = ['term_id', 'name', 'slug', 'city', 'state', 'country'] as const;
const EVENTON_ORGANIZER_KEYS = ['term_id', 'name', 'slug'] as const;

// Compact per-item keys for EventON RSVP attendees (`attendees` envelope).
export const EVENTON_ATTENDEE_LIST_FIELDS = [
  'id',
  'full_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'rsvp',
  'status',
  'rsvp_type',
  'count',
  'headcount',
  'repeat_interval',
  'event_time',
  'created_at',
  'updated_at'
] as const;

// Dropped from single-item reads by default: HAL links and guid are noise for
// the model and cost tokens on every call.
export const DEFAULT_ITEM_STRIP_FIELDS = ['_links', 'guid'] as const;

export const EXCERPT_MAX_LENGTH = 300;

type ItemKind = 'post' | 'event' | 'attendee';

// Envelope keys whose arrays hold content items (see extractContentCollection),
// with the item shape each one carries.
const ENVELOPE_ITEM_KINDS: Record<string, ItemKind | undefined> = {
  events: 'event',
  attendees: 'attendee',
  items: undefined,
  data: undefined,
  results: undefined
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function renderedString(value: unknown): unknown {
  if (isRecord(value) && typeof value.rendered === 'string') {
    return value.rendered;
  }
  return value;
}

export function toPlainTextExcerpt(value: unknown, maxLength = EXCERPT_MAX_LENGTH): string {
  const text = renderedString(value);
  if (typeof text !== 'string') {
    return '';
  }

  const plain = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&hellip;|&#8230;/g, '...')
    .replace(/\s+/g, ' ')
    .trim();

  return plain.length > maxLength ? `${plain.slice(0, maxLength).trimEnd()}...` : plain;
}

// EventON APIfy events are recognized by shape when no envelope says so
// (e.g. a slug-search match): start fields plus event_status.
export function isEventONEventItem(item: Record<string, unknown>): boolean {
  return ('start_date' in item || 'start_at' in item) && 'event_status' in item;
}

function pickTermKeys(value: unknown, keys: readonly string[]): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const reduced: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in value && value[key] !== '' && value[key] !== null) {
      reduced[key] = value[key];
    }
  }
  return reduced;
}

function projectCompactEvent(item: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of EVENTON_EVENT_LIST_FIELDS) {
    if (!(key in item)) continue;
    if (key === 'title') {
      projected.title = renderedString(item.title);
    } else if (key === 'excerpt' || key === 'event_excerpt') {
      projected[key] = toPlainTextExcerpt(item[key]);
    } else if (key === 'location') {
      projected.location = pickTermKeys(item.location, EVENTON_LOCATION_KEYS);
    } else if (key === 'organizers') {
      projected.organizers = Array.isArray(item.organizers)
        ? item.organizers.map((organizer) => pickTermKeys(organizer, EVENTON_ORGANIZER_KEYS))
        : item.organizers;
    } else {
      projected[key] = item[key];
    }
  }
  return projected;
}

function projectCompactItem(item: Record<string, unknown>, kind?: ItemKind): Record<string, unknown> {
  const resolvedKind = kind || (isEventONEventItem(item) ? 'event' : 'post');
  if (resolvedKind === 'event') {
    return projectCompactEvent(item);
  }
  if (resolvedKind === 'attendee') {
    return pickFields(item, [...EVENTON_ATTENDEE_LIST_FIELDS]);
  }

  const projected: Record<string, unknown> = {};
  for (const key of DEFAULT_LIST_ITEM_FIELDS) {
    if (!(key in item)) continue;
    if (key === 'title') {
      projected.title = renderedString(item.title);
    } else if (key === 'excerpt') {
      projected.excerpt = toPlainTextExcerpt(item.excerpt);
    } else {
      projected[key] = item[key];
    }
  }
  return projected;
}

function pickFields(item: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in item) projected[key] = item[key];
  }
  return projected;
}

export function projectListItem(item: unknown, fields?: ContentFieldsSelection, kind?: ItemKind): unknown {
  if (fields === 'full' || !isRecord(item)) {
    return item;
  }
  return Array.isArray(fields) ? pickFields(item, fields) : projectCompactItem(item, kind);
}

/**
 * Project a list response. Arrays are projected item by item; envelopes keep
 * their metadata (total, pages, ...) and only their item arrays are projected.
 * `fields: "full"` returns the response untouched.
 */
export function projectListResponse(response: unknown, fields?: ContentFieldsSelection): unknown {
  if (fields === 'full') {
    return response;
  }

  if (Array.isArray(response)) {
    return response.map((item) => projectListItem(item, fields));
  }

  if (isRecord(response)) {
    const projected: Record<string, unknown> = { ...response };
    for (const [key, kind] of Object.entries(ENVELOPE_ITEM_KINDS)) {
      if (Array.isArray(response[key])) {
        projected[key] = (response[key] as unknown[]).map((item) => projectListItem(item, fields, kind));
      }
    }
    return projected;
  }

  return response;
}

/**
 * Project a single item read. By default the full item is kept (callers need
 * the content) minus `_links` and `guid`. An array keeps only those keys.
 */
export function projectContentItem(item: unknown, fields?: ContentFieldsSelection): unknown {
  if (fields === 'full' || !isRecord(item)) {
    return item;
  }

  if (Array.isArray(fields)) {
    return pickFields(item, fields);
  }

  const projected: Record<string, unknown> = { ...item };
  for (const key of DEFAULT_ITEM_STRIP_FIELDS) {
    delete projected[key];
  }
  return projected;
}
