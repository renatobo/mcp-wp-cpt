const CONTENT_TYPE_IDENTIFIER_PATTERN = /^[a-z0-9_-]+$/i;

// Content type identifiers become URL path segments. Anything beyond letters,
// digits, `_` and `-` (e.g. `://`, `..`, `/`, `?`, `#`, whitespace) could redirect
// the authenticated request to another host or another REST namespace.
export function assertValidContentTypeIdentifier(contentType: unknown): asserts contentType is string {
  if (typeof contentType !== 'string' || !CONTENT_TYPE_IDENTIFIER_PATTERN.test(contentType)) {
    throw new Error(
      `Invalid content type "${String(contentType)}": content type identifiers may only contain letters, digits, "_" and "-".`
    );
  }
}

// Pure slug-to-endpoint mapping for core types. Callers that know the site's
// rest_base should use resolveContentEndpoint (src/content/content-types.ts).
export function getContentEndpoint(contentType: string): string {
  assertValidContentTypeIdentifier(contentType);

  const endpointMap: Record<string, string> = {
    post: 'posts',
    page: 'pages'
  };

  return endpointMap[contentType] || contentType;
}

// Envelope keys whose arrays hold content items: EventON `events`, EventON RSVP
// `attendees`, and common generic wrappers.
export const CONTENT_COLLECTION_ENVELOPE_KEYS = ['events', 'attendees', 'items', 'data', 'results'] as const;

// Normalizes list responses into an array of items. Standard wp/v2 collections
// are arrays, while plugin endpoints (e.g. EventON `eventonapify/v1/events`)
// wrap their results in a keyed envelope such as `{ events: [...] }`.
export function extractContentCollection(response: unknown): any[] {
  if (Array.isArray(response)) {
    return response;
  }

  if (response && typeof response === 'object') {
    const payload = response as Record<string, unknown>;
    for (const key of CONTENT_COLLECTION_ENVELOPE_KEYS) {
      if (Array.isArray(payload[key])) {
        return payload[key] as any[];
      }
    }
  }

  return [];
}

// Matches a content item by slug across the shapes different endpoints use.
export function findItemBySlug(items: any[], slug: string): any | undefined {
  return items.find((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }

    if (item.slug === slug || item.post_name === slug) {
      return true;
    }

    const link =
      typeof item.link === 'string'
        ? item.link
        : typeof item.permalink === 'string'
          ? item.permalink
          : undefined;

    if (link) {
      const parts = link.replace(/\/+$/, '').split('/').filter(Boolean);
      return parts[parts.length - 1] === slug;
    }

    return false;
  });
}

export function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }

  return value;
}

export function appendEndpointId(endpoint: string, id: number): string {
  const normalized = endpoint.replace(/^\/+|\/+$/g, '');
  return `${normalized}/${id}`;
}

export function splitNamespacedEndpoint(
  endpoint: string | undefined,
  fallbackEndpoint: string
): { namespace?: string; endpoint: string } {
  if (!endpoint) {
    return { endpoint: fallbackEndpoint };
  }

  const normalized = endpoint.replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');

  if (parts.length >= 3 && parts[0] === 'wp-json') {
    const namespace = `${parts[1]}/${parts[2]}`;
    const relativeEndpoint = parts.slice(3).join('/');
    return {
      namespace,
      endpoint: relativeEndpoint || fallbackEndpoint
    };
  }

  if (parts.length >= 3 && parts[0] === 'wp' && parts[1].startsWith('v')) {
    const namespace = `${parts[0]}/${parts[1]}`;
    const relativeEndpoint = parts.slice(2).join('/');
    return {
      namespace,
      endpoint: relativeEndpoint || fallbackEndpoint
    };
  }

  if (parts.length >= 3 && /^v\d+/.test(parts[1])) {
    const namespace = `${parts[0]}/${parts[1]}`;
    const relativeEndpoint = parts.slice(2).join('/');
    return {
      namespace,
      endpoint: relativeEndpoint || fallbackEndpoint
    };
  }

  return { endpoint: normalized || fallbackEndpoint };
}

export const EVENTON_EVENTS_CONTENT_TYPE = 'ajde_events';
export const EVENTON_APIFY_NAMESPACE = 'eventonapify/v1';
export const EVENTON_APIFY_EVENTS_ENDPOINT = 'events';

// WordPress error codes EventON APIfy returns (HTTP 403) when the plugin is
// installed but its API is switched off, globally or for one route capability
// (see the plugin's rest-access-control.php). Native wp/v2 routes keep working.
export const EVENTON_API_DISABLED_ERROR_CODES = ['eventon_apify_disabled', 'eventon_apify_capability_disabled'];

// Content types whose reads/writes are rewritten to a plugin endpoint by
// getPreferredReadEndpoint/getDefensiveEndpointFallback. EventON 5.x registers
// ajde_events with show_in_rest=true (rest_base ajde_events), but older or
// filtered installs may hide it from /types, so it stays resolvable regardless.
export const PROVIDER_ROUTED_CONTENT_TYPES: ReadonlySet<string> = new Set([EVENTON_EVENTS_CONTENT_TYPE]);

export function isEventONApifyEventsEndpoint(endpoint: string | undefined, namespace: string | undefined): boolean {
  return namespace === EVENTON_APIFY_NAMESPACE && endpoint?.replace(/^\/+|\/+$/g, '') === EVENTON_APIFY_EVENTS_ENDPOINT;
}

export function getDefensiveEndpointFallback(args: {
  contentType: string;
  provider?: string;
  endpoint: string;
  namespace?: string;
}): { endpoint: string; namespace?: string } | undefined {
  const namespace = args.namespace || 'wp/v2';
  const endpoint = args.endpoint.replace(/^\/+|\/+$/g, '');

  if (
    args.provider === 'eventon-apify' &&
    args.contentType === EVENTON_EVENTS_CONTENT_TYPE &&
    namespace === 'wp/v2' &&
    endpoint === EVENTON_EVENTS_CONTENT_TYPE
  ) {
    return {
      endpoint: EVENTON_APIFY_EVENTS_ENDPOINT,
      namespace: EVENTON_APIFY_NAMESPACE
    };
  }

  return undefined;
}

export interface PreferredEndpoint {
  endpoint: string;
  namespace?: string;
  fallbackOn404?: { endpoint: string; namespace?: string; on403Codes?: string[] };
}

export function getPreferredReadEndpoint(args: {
  contentType: string;
  provider?: string;
  endpoint: string;
  namespace?: string;
}): PreferredEndpoint {
  const endpoint = args.endpoint.replace(/^\/+|\/+$/g, '');
  const namespace = args.namespace || 'wp/v2';

  // Route EventON event lists/reads to the plugin events endpoint by content type
  // alone (mirroring getDefensiveEndpointFallback). The provider is only known when
  // a manifest resolves, but ajde_events must use this endpoint even when it does not,
  // so after/before map to event start dates instead of the WordPress publish date.
  // Manifests may publish either wp/v2/ajde_events (APIfy 3.5.1) or
  // eventonapify/v1/events (3.5.2+) as the preferred endpoint; both read from APIfy and fall
  // back to wp/v2 when the namespace is missing (404) or the APIfy API is disabled
  // (403), since the native route still serves the posts.
  if (
    args.contentType === EVENTON_EVENTS_CONTENT_TYPE &&
    ((namespace === 'wp/v2' && endpoint === EVENTON_EVENTS_CONTENT_TYPE) ||
      isEventONApifyEventsEndpoint(endpoint, namespace))
  ) {
    return {
      endpoint: EVENTON_APIFY_EVENTS_ENDPOINT,
      namespace: EVENTON_APIFY_NAMESPACE,
      fallbackOn404: {
        endpoint: EVENTON_EVENTS_CONTENT_TYPE,
        namespace: 'wp/v2',
        on403Codes: EVENTON_API_DISABLED_ERROR_CODES
      }
    };
  }

  return {
    endpoint,
    namespace,
    fallbackOn404: getDefensiveEndpointFallback(args)
  };
}

// EventON's wp/v2 compatibility route creates the post but is not the
// transactional EventON writer. Contract-backed writes must use the APIfy
// events endpoint, which persists EventON meta and term assignments together.
export function getPreferredWriteEndpoint(args: {
  contentType: string;
  provider?: string;
  endpoint: string;
  namespace?: string;
}): { endpoint: string; namespace?: string; fallbackOn404?: { endpoint: string; namespace?: string } } {
  if (args.contentType === EVENTON_EVENTS_CONTENT_TYPE && args.provider === 'eventon-apify') {
    return {
      endpoint: EVENTON_APIFY_EVENTS_ENDPOINT,
      namespace: EVENTON_APIFY_NAMESPACE
    };
  }

  return {
    endpoint: args.endpoint,
    namespace: args.namespace,
    fallbackOn404: getDefensiveEndpointFallback(args)
  };
}
