import { resolveContentTypeContract } from '../adapters/registry.js';
import {
  ContractCompatibilityError,
  ContractResolution
} from '../adapters/types.js';
import {
  EVENTON_EVENTS_CONTENT_TYPE,
  getContentEndpoint,
  getPreferredReadEndpoint,
  getDefensiveEndpointFallback,
  isEventONApifyEventsEndpoint,
  PreferredEndpoint,
  removeUndefinedValues,
  splitNamespacedEndpoint
} from './utils.js';
import { ContentTypeResolverDependencies, resolveContentType } from './content-types.js';

export interface PrepareListContentRequestArgs {
  contentType: string;
  siteId?: string;
  input: Record<string, unknown>;
  refreshCache?: boolean;
  contentTypeResolver?: ContentTypeResolverDependencies;
}

export interface ListRequestFallback {
  endpoint: string;
  namespace?: string;
  on403Codes?: string[];
  // Query params for the fallback route when its vocabulary differs from the
  // primary one (EventON: the wp/v2 route takes after/before/orderby as-is).
  data?: Record<string, unknown>;
}

export interface PreparedListContentRequest {
  endpoint: string;
  namespace?: string;
  fallbackOn404?: ListRequestFallback;
  queryParams: Record<string, unknown>;
  // Non-fatal notices about the request (e.g. params the endpoint ignores).
  warnings?: string[];
  contractResolution: ContractResolution;
}

export interface PrepareGetContentRequestArgs {
  contentType: string;
  siteId?: string;
  refreshCache?: boolean;
  contentTypeResolver?: ContentTypeResolverDependencies;
}

export interface PreparedGetContentRequest {
  endpoint: string;
  namespace?: string;
  fallbackOn404?: {
    endpoint: string;
    namespace?: string;
    on403Codes?: string[];
  };
  contractResolution: ContractResolution;
}

export async function prepareListContentRequest(
  args: PrepareListContentRequestArgs
): Promise<PreparedListContentRequest> {
  const resolvedType = await resolveContentType(args.contentType, args.siteId, args.contentTypeResolver, {
    forceRefresh: args.refreshCache
  });
  const contractResolution = await resolveContentTypeContract(
    resolvedType.slug,
    args.siteId,
    args.refreshCache
  );

  const queryParams = toListQueryParams(args.input);

  return buildListContentRequest(queryParams, contractResolution, resolvedType.restBase);
}

// Tool-only params that must never reach WordPress as query params. `fields`
// is the client-side projection selector (see src/content/projection.ts); sent
// as a query param it would collide with plugin params of the same name.
const TOOL_ONLY_LIST_PARAMS = ['content_type', 'site_id', 'refresh_cache', 'fields'];

export function toListQueryParams(input: Record<string, unknown>): Record<string, unknown> {
  const queryParams = removeUndefinedValues({
    ...input
  });

  for (const key of TOOL_ONLY_LIST_PARAMS) {
    delete queryParams[key];
  }

  return queryParams;
}

export async function prepareGetContentRequest(
  args: PrepareGetContentRequestArgs
): Promise<PreparedGetContentRequest> {
  const resolvedType = await resolveContentType(args.contentType, args.siteId, args.contentTypeResolver, {
    forceRefresh: args.refreshCache
  });
  const contractResolution = await resolveContentTypeContract(
    resolvedType.slug,
    args.siteId,
    args.refreshCache
  );

  return buildGetContentRequest(contractResolution, resolvedType.restBase);
}

// `resolvedEndpoint` is the site's rest_base from resolveContentEndpoint; it
// defaults to the pure slug mapping so these builders stay usable in isolation.
export function buildListContentRequest(
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution,
  resolvedEndpoint: string = getContentEndpoint(contractResolution.contentType)
): PreparedListContentRequest {
  if (canUseContractListRequest(contractResolution)) {
    return buildContractListRequest(
      queryParams,
      contractResolution,
      resolvedEndpoint
    );
  }

  if (canUseDirectContractReadRequest(contractResolution)) {
    return buildDirectContractReadRequest(queryParams, contractResolution, resolvedEndpoint);
  }

  // No contract resolved: still route through getPreferredReadEndpoint so EventON
  // ajde_events lists hit the plugin events endpoint and get start-date semantics for
  // after/before. For every other type this is a no-op (endpoint/namespace unchanged,
  // same defensive 404 fallback).
  const preferredRead = getPreferredReadEndpoint({
    contentType: contractResolution.contentType,
    provider: contractResolution.manifest?.provider,
    endpoint: resolvedEndpoint
  });

  return finalizeListRequest(queryParams, contractResolution, preferredRead);
}

export function buildGetContentRequest(
  contractResolution: ContractResolution,
  resolvedEndpoint: string = getContentEndpoint(contractResolution.contentType)
): PreparedGetContentRequest {
  assertContractSupportsItemRead(contractResolution);

  if (canUseContractGetRequest(contractResolution)) {
    const split = splitNamespacedEndpoint(
      contractResolution.contract?.preferred_endpoint,
      resolvedEndpoint
    );
    const preferredRead = getPreferredReadEndpoint({
      contentType: contractResolution.contentType,
      provider: contractResolution.manifest?.provider,
      endpoint: split.endpoint,
      namespace: split.namespace || contractResolution.manifest?.namespace
    });

    return {
      endpoint: preferredRead.endpoint,
      namespace: preferredRead.namespace,
      fallbackOn404: preferredRead.fallbackOn404,
      contractResolution
    };
  }

  return {
    endpoint: resolvedEndpoint,
    fallbackOn404: getDefensiveEndpointFallback({
      contentType: contractResolution.contentType,
      provider: contractResolution.manifest?.provider,
      endpoint: resolvedEndpoint
    }),
    contractResolution
  };
}

// List routing is intentionally independent from write interpreter readiness.
export function canUseContractListRequest(contractResolution: ContractResolution): boolean {
  return Boolean(
    contractResolution.contract &&
      contractResolution.manifest &&
      contractResolution.contract.preferred_endpoint &&
      contractResolution.contract.supported_operations?.includes('list')
  );
}

export function canUseContractGetRequest(contractResolution: ContractResolution): boolean {
  return Boolean(
    contractResolution.contract &&
      contractResolution.manifest &&
      contractResolution.contract.preferred_endpoint &&
      !contractResolution.contract.preferred_endpoint.includes('{')
  );
}

export function canUseDirectContractReadRequest(contractResolution: ContractResolution): boolean {
  return canUseContractGetRequest(contractResolution);
}

export function buildContractListRequest(
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution,
  fallbackEndpoint: string = getContentEndpoint(contractResolution.contentType)
): PreparedListContentRequest {
  const split = splitNamespacedEndpoint(
    contractResolution.contract?.preferred_endpoint,
    fallbackEndpoint
  );

  const endpoint = resolveEndpointTemplate(
    split.endpoint,
    queryParams,
    contractResolution
  );
  const preferredRead = getPreferredReadEndpoint({
    contentType: contractResolution.contentType,
    provider: contractResolution.manifest?.provider,
    endpoint,
    namespace: split.namespace || contractResolution.manifest?.namespace
  });

  return finalizeListRequest(queryParams, contractResolution, preferredRead);
}

function buildDirectContractReadRequest(
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution,
  fallbackEndpoint: string
): PreparedListContentRequest {
  const split = splitNamespacedEndpoint(
    contractResolution.contract?.preferred_endpoint,
    fallbackEndpoint
  );
  const preferredRead = getPreferredReadEndpoint({
    contentType: contractResolution.contentType,
    provider: contractResolution.manifest?.provider,
    endpoint: split.endpoint,
    namespace: split.namespace || contractResolution.manifest?.namespace
  });

  return finalizeListRequest(queryParams, contractResolution, preferredRead);
}

function finalizeListRequest(
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution,
  preferredRead: PreferredEndpoint
): PreparedListContentRequest {
  const prepared: PreparedListContentRequest = {
    endpoint: preferredRead.endpoint,
    namespace: preferredRead.namespace,
    fallbackOn404: preferredRead.fallbackOn404,
    queryParams,
    contractResolution
  };

  // The resolved read endpoint is the authoritative signal: getPreferredReadEndpoint
  // only returns eventonapify/v1/events for ajde_events, so no provider check is
  // needed and this also covers the no-contract fallback path.
  const isEventOnEventList =
    contractResolution.contentType === EVENTON_EVENTS_CONTENT_TYPE &&
    isEventONApifyEventsEndpoint(preferredRead.endpoint, preferredRead.namespace);

  if (!isEventOnEventList) {
    return prepared;
  }

  const { fallbackQueryParams, warnings } = normalizeEventONListQueryParams(queryParams, contractResolution);
  if (prepared.fallbackOn404) {
    prepared.fallbackOn404 = { ...prepared.fallbackOn404, data: fallbackQueryParams };
  }
  if (warnings.length > 0) {
    prepared.warnings = warnings;
  }

  return prepared;
}

// Query params accepted by EventON APIfy `GET eventonapify/v1/events`
// (rest-routes.php / rest-events-list.php). Manifests that publish
// read_contract.filters extend this list.
export const EVENTON_EVENTS_LIST_PARAMS = [
  'page',
  'per_page',
  'search',
  'slug',
  'status',
  'starts_on_or_after',
  'starts_before',
  'upcoming',
  'order',
  'orderby'
] as const;

// WordPress-style orderby values mapped onto the APIfy vocabulary
// (start_at, created, modified, title).
const EVENTON_ORDERBY_MAP: Record<string, string> = {
  start_at: 'start_at',
  created: 'created',
  date: 'created',
  modified: 'modified',
  title: 'title'
};

// APIfy orderby values mapped back to wp/v2 for the native fallback route.
const WP_V2_ORDERBY_MAP: Record<string, string> = {
  created: 'date',
  date: 'date',
  modified: 'modified',
  title: 'title'
};

function getEventONAcceptedListParams(contractResolution: ContractResolution): Set<string> {
  const accepted = new Set<string>(EVENTON_EVENTS_LIST_PARAMS);
  const readContract = contractResolution.contract?.read_contract;
  const filters = readContract && typeof readContract === 'object' && !Array.isArray(readContract)
    ? (readContract as Record<string, unknown>).filters
    : undefined;

  if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
    for (const key of Object.keys(filters)) {
      accepted.add(key);
    }
  }

  return accepted;
}

/**
 * Rewrites list params for `eventonapify/v1/events` in place. `after`/`before`
 * become the event start-date filters, WordPress orderby values are mapped to
 * the APIfy vocabulary, and params the endpoint does not accept are dropped with
 * a warning instead of silently returning unfiltered results. Filtering, sorting
 * and pagination are left to the server.
 *
 * Returns the untouched params for the wp/v2 fallback, where after/before filter
 * the WordPress publish date and categories/tags/author apply natively.
 */
function normalizeEventONListQueryParams(
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution
): { fallbackQueryParams: Record<string, unknown>; warnings: string[] } {
  const fallbackQueryParams: Record<string, unknown> = { ...queryParams };
  const warnings: string[] = [];

  for (const key of ['starts_on_or_after', 'starts_before', 'upcoming']) {
    delete fallbackQueryParams[key];
  }
  if (typeof fallbackQueryParams.orderby === 'string') {
    const wpOrderby = WP_V2_ORDERBY_MAP[fallbackQueryParams.orderby.toLowerCase()];
    if (wpOrderby) {
      fallbackQueryParams.orderby = wpOrderby;
    } else {
      delete fallbackQueryParams.orderby;
    }
  }

  if (typeof queryParams.after === 'string' && queryParams.starts_on_or_after === undefined) {
    queryParams.starts_on_or_after = queryParams.after;
  }
  if (typeof queryParams.before === 'string' && queryParams.starts_before === undefined) {
    queryParams.starts_before = queryParams.before;
  }
  delete queryParams.after;
  delete queryParams.before;

  if (queryParams.orderby !== undefined) {
    const requested = String(queryParams.orderby);
    const mapped = EVENTON_ORDERBY_MAP[requested.toLowerCase()];
    if (mapped) {
      queryParams.orderby = mapped;
    } else {
      delete queryParams.orderby;
      warnings.push(
        `orderby "${requested}" is not supported by eventonapify/v1/events (use start_at, created/date, modified, or title); ` +
          'results use the default start_at order.'
      );
    }
  }

  const accepted = getEventONAcceptedListParams(contractResolution);
  const ignored = Object.keys(queryParams).filter((key) => !accepted.has(key));
  for (const key of ignored) {
    delete queryParams[key];
  }
  if (ignored.length > 0) {
    warnings.push(
      `eventonapify/v1/events does not support these list params, so they were not applied: ${ignored.join(', ')}. ` +
        `Supported params: ${Array.from(accepted).join(', ')}.`
    );
  }

  return { fallbackQueryParams, warnings };
}

// Item reads on templated (nested) or read-only contracts cannot be expressed
// as `<endpoint>/<id>`; fail clearly rather than request a literal `{param}` path
// or a wp/v2 route that does not exist.
function assertContractSupportsItemRead(contractResolution: ContractResolution): void {
  const contract = contractResolution.contract;
  if (!contract || !contractResolution.manifest) {
    return;
  }

  const templated = Boolean(contract.preferred_endpoint?.includes('{'));
  const readOnly = contract.preferred_write_mode === 'read_only';
  const operations = contract.supported_operations;
  if ((templated || readOnly) && operations && !operations.includes('get')) {
    throw new ContractCompatibilityError(
      `${contractResolution.contentType} does not support single-item reads (supported operations: ${operations.join(', ') || 'none'}).` +
        (operations.includes('list') ? ' Use list_content instead.' : ''),
      {
        content_type: contractResolution.contentType,
        site_id: contractResolution.siteId,
        supported_operations: operations,
        preferred_write_mode: contract.preferred_write_mode,
        parent_context: contract.parent_context
      }
    );
  }
}

function resolveEndpointTemplate(
  endpointTemplate: string,
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution
): string {
  const tokens = Array.from(endpointTemplate.matchAll(/\{([a-zA-Z0-9_]+)\}/g)).map((match) => match[1]);

  if (tokens.length === 0) {
    return endpointTemplate;
  }

  let endpoint = endpointTemplate;
  for (const token of tokens) {
    const value = queryParams[token];

    if (value === undefined || value === null || value === '') {
      const details: Record<string, unknown> = {
        content_type: contractResolution.contentType,
        site_id: contractResolution.siteId,
        missing_parameter: token
      };

      if (contractResolution.contract?.parent_context?.id_param === token) {
        details.parent_context = contractResolution.contract.parent_context;
      }

      throw new ContractCompatibilityError(
        `Listing ${contractResolution.contentType} requires the \`${token}\` parameter to resolve its contract endpoint.`,
        details
      );
    }

    endpoint = endpoint.replaceAll(`{${token}}`, encodeURIComponent(String(value)));
    delete queryParams[token];
  }

  return endpoint;
}
