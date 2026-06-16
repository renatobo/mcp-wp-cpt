import { resolveContentTypeContract } from '../adapters/registry.js';
import {
  ContractCompatibilityError,
  ContractResolution
} from '../adapters/types.js';
import {
  getContentEndpoint,
  getPreferredReadEndpoint,
  getDefensiveEndpointFallback,
  removeUndefinedValues,
  splitNamespacedEndpoint
} from './utils.js';

export interface PrepareListContentRequestArgs {
  contentType: string;
  siteId?: string;
  input: Record<string, unknown>;
  refreshCache?: boolean;
}

export interface PreparedListContentRequest {
  endpoint: string;
  namespace?: string;
  fallbackOn404?: {
    endpoint: string;
    namespace?: string;
  };
  queryParams: Record<string, unknown>;
  responseFilter?: {
    eventStartAfter?: string;
    eventStartBefore?: string;
    eventStartOrder?: 'asc' | 'desc';
  };
  contractResolution: ContractResolution;
}

export interface PrepareGetContentRequestArgs {
  contentType: string;
  siteId?: string;
  refreshCache?: boolean;
}

export interface PreparedGetContentRequest {
  endpoint: string;
  namespace?: string;
  fallbackOn404?: {
    endpoint: string;
    namespace?: string;
  };
  contractResolution: ContractResolution;
}

export async function prepareListContentRequest(
  args: PrepareListContentRequestArgs
): Promise<PreparedListContentRequest> {
  const contractResolution = await resolveContentTypeContract(
    args.contentType,
    args.siteId,
    args.refreshCache
  );

  const queryParams = removeUndefinedValues({
    ...args.input
  });

  delete queryParams.content_type;
  delete queryParams.site_id;
  delete queryParams.refresh_cache;

  return buildListContentRequest(queryParams, contractResolution);
}

export async function prepareGetContentRequest(
  args: PrepareGetContentRequestArgs
): Promise<PreparedGetContentRequest> {
  const contractResolution = await resolveContentTypeContract(
    args.contentType,
    args.siteId,
    args.refreshCache
  );

  return buildGetContentRequest(contractResolution);
}

export function buildListContentRequest(
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution
): PreparedListContentRequest {
  if (canUseContractListRequest(contractResolution)) {
    return buildContractListRequest(
      queryParams,
      contractResolution
    );
  }

  if (canUseDirectContractReadRequest(contractResolution)) {
    return buildDirectContractReadRequest(queryParams, contractResolution);
  }

  return {
    endpoint: getContentEndpoint(contractResolution.contentType),
    fallbackOn404: getDefensiveEndpointFallback({
      contentType: contractResolution.contentType,
      provider: contractResolution.manifest?.provider,
      endpoint: getContentEndpoint(contractResolution.contentType)
    }),
    queryParams,
    contractResolution
  };
}

export function buildGetContentRequest(
  contractResolution: ContractResolution
): PreparedGetContentRequest {
  if (canUseContractGetRequest(contractResolution)) {
    const fallbackEndpoint = getContentEndpoint(contractResolution.contentType);
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

    return {
      endpoint: preferredRead.endpoint,
      namespace: preferredRead.namespace,
      fallbackOn404: preferredRead.fallbackOn404,
      contractResolution
    };
  }

  return {
    endpoint: getContentEndpoint(contractResolution.contentType),
    fallbackOn404: getDefensiveEndpointFallback({
      contentType: contractResolution.contentType,
      provider: contractResolution.manifest?.provider,
      endpoint: getContentEndpoint(contractResolution.contentType)
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
  contractResolution: ContractResolution
): PreparedListContentRequest {
  const fallbackEndpoint = getContentEndpoint(contractResolution.contentType);
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
  const responseFilter = normalizeContractListQueryParamsForRead(
    queryParams,
    contractResolution,
    preferredRead
  );

  return {
    endpoint: preferredRead.endpoint,
    namespace: preferredRead.namespace,
    fallbackOn404: preferredRead.fallbackOn404,
    queryParams,
    responseFilter,
    contractResolution
  };
}

function buildDirectContractReadRequest(
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution
): PreparedListContentRequest {
  const fallbackEndpoint = getContentEndpoint(contractResolution.contentType);
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
  const responseFilter = normalizeContractListQueryParamsForRead(
    queryParams,
    contractResolution,
    preferredRead
  );

  return {
    endpoint: preferredRead.endpoint,
    namespace: preferredRead.namespace,
    fallbackOn404: preferredRead.fallbackOn404,
    queryParams,
    responseFilter,
    contractResolution
  };
}

function normalizeContractListQueryParamsForRead(
  queryParams: Record<string, unknown>,
  contractResolution: ContractResolution,
  preferredRead: {
    endpoint: string;
    namespace?: string;
  }
): PreparedListContentRequest['responseFilter'] | undefined {
  const isEventOnEventList =
    contractResolution.contentType === 'ajde_events' &&
    contractResolution.manifest?.provider === 'eventon-apify' &&
    preferredRead.namespace === 'eventonapify/v1' &&
    preferredRead.endpoint === 'events';

  if (!isEventOnEventList) {
    return undefined;
  }

  const responseFilter: PreparedListContentRequest['responseFilter'] = {};
  const after = typeof queryParams.after === 'string' ? queryParams.after : undefined;
  const before = typeof queryParams.before === 'string' ? queryParams.before : undefined;
  const order = queryParams.order === 'desc' ? 'desc' : 'asc';

  if (after) {
    queryParams.starts_on_or_after = after;
    responseFilter.eventStartAfter = after;
  }

  if (before) {
    queryParams.starts_before = before;
    responseFilter.eventStartBefore = before;
  }

  responseFilter.eventStartOrder = order;

  delete queryParams.after;
  delete queryParams.before;
  delete queryParams.orderby;

  return responseFilter;
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
