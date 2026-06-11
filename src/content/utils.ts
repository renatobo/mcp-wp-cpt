export function getContentEndpoint(contentType: string): string {
  const endpointMap: Record<string, string> = {
    post: 'posts',
    page: 'pages'
  };

  return endpointMap[contentType] || contentType;
}

export function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }

  return value;
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
