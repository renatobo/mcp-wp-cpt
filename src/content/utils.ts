export function getContentEndpoint(contentType: string): string {
  const endpointMap: Record<string, string> = {
    post: 'posts',
    page: 'pages'
  };

  return endpointMap[contentType] || contentType;
}

// Normalizes list responses into an array of items. Standard wp/v2 collections
// are arrays, while plugin endpoints (e.g. EventON `eventonapify/v1/events`)
// wrap their results in a keyed envelope such as `{ events: [...] }`.
export function extractContentCollection(response: unknown): any[] {
  if (Array.isArray(response)) {
    return response;
  }

  if (response && typeof response === 'object') {
    const payload = response as Record<string, unknown>;
    for (const key of ['events', 'items', 'data', 'results']) {
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
    args.contentType === 'ajde_events' &&
    namespace === 'wp/v2' &&
    endpoint === 'ajde_events'
  ) {
    return {
      endpoint: 'events',
      namespace: 'eventonapify/v1'
    };
  }

  return undefined;
}

export function getPreferredReadEndpoint(args: {
  contentType: string;
  provider?: string;
  endpoint: string;
  namespace?: string;
}): { endpoint: string; namespace?: string; fallbackOn404?: { endpoint: string; namespace?: string } } {
  const endpoint = args.endpoint.replace(/^\/+|\/+$/g, '');
  const namespace = args.namespace || 'wp/v2';

  if (
    args.provider === 'eventon-apify' &&
    args.contentType === 'ajde_events' &&
    namespace === 'wp/v2' &&
    endpoint === 'ajde_events'
  ) {
    return {
      endpoint: 'events',
      namespace: 'eventonapify/v1',
      fallbackOn404: {
        endpoint: 'ajde_events',
        namespace: 'wp/v2'
      }
    };
  }

  return {
    endpoint,
    namespace,
    fallbackOn404: getDefensiveEndpointFallback(args)
  };
}
