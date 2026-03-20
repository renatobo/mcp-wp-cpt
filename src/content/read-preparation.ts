import { resolveContentTypeContract } from '../adapters/registry.js';
import {
  ContractCompatibilityError,
  ContractResolution
} from '../adapters/types.js';
import { getContentEndpoint, removeUndefinedValues, splitNamespacedEndpoint } from './utils.js';

export interface PrepareListContentRequestArgs {
  contentType: string;
  siteId?: string;
  input: Record<string, unknown>;
  refreshCache?: boolean;
}

export interface PreparedListContentRequest {
  endpoint: string;
  namespace?: string;
  queryParams: Record<string, unknown>;
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

  return {
    endpoint: getContentEndpoint(contractResolution.contentType),
    queryParams,
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

  return {
    endpoint,
    namespace: split.namespace || contractResolution.manifest?.namespace,
    queryParams,
    contractResolution
  };
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
