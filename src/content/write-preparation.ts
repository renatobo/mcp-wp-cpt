import { logToFile } from '../wordpress.js';
import { resolveContentTypeContract } from '../adapters/registry.js';
import { prepareContractWriteRequest } from '../adapters/interpreter.js';
import {
  AdaptedWriteInput,
  ContractCompatibilityError,
  ContractResolution,
  ContractValidationError,
  PreparedContentRequest
} from '../adapters/types.js';
import {
  appendEndpointId,
  EVENTON_APIFY_EVENTS_ENDPOINT,
  EVENTON_APIFY_NAMESPACE,
  EVENTON_EVENTS_CONTENT_TYPE,
  getContentEndpoint,
  getDefensiveEndpointFallback,
  splitNamespacedEndpoint
} from './utils.js';
import { buildBaseContentPayload } from './payloads.js';
import { ContentTypeResolverDependencies, resolveContentType } from './content-types.js';

export interface PrepareContentWriteRequestArgs {
  operation: 'create' | 'update';
  contentType: string;
  siteId?: string;
  input: AdaptedWriteInput;
  refreshCache?: boolean;
  contentTypeResolver?: ContentTypeResolverDependencies;
}

export interface PreparedContentWriteRequest extends PreparedContentRequest {
  contractResolution: ContractResolution;
}

export interface PrepareContentDeleteRequestArgs {
  contentType: string;
  id: number;
  siteId?: string;
  force?: boolean;
  refreshCache?: boolean;
  contentTypeResolver?: ContentTypeResolverDependencies;
}

export interface BuildContentDeleteRequestArgs {
  contentType: string;
  id: number;
  force?: boolean;
  contractResolution: ContractResolution;
  // Site rest_base from resolveContentEndpoint; defaults to the pure slug mapping.
  endpoint?: string;
}

export interface PreparedContentDeleteRequest extends PreparedContentRequest {
  contractResolution: ContractResolution;
}

export async function prepareContentWriteRequest(
  args: PrepareContentWriteRequestArgs
): Promise<PreparedContentWriteRequest> {
  const resolvedType = await resolveContentType(args.contentType, args.siteId, args.contentTypeResolver, {
    forceRefresh: args.refreshCache
  });
  const contentType = resolvedType.slug;
  const contractResolution = await resolveContentTypeContract(
    contentType,
    args.siteId,
    args.refreshCache
  );

  assertContractSupportsOperation(contractResolution, args.operation);

  if (
    contractResolution.status === 'supported' &&
    contractResolution.contract &&
    contractResolution.manifest
  ) {
    logToFile(`Using contract interpreter for ${contentType} on site ${contractResolution.siteId}`);
    const context = {
      siteId: contractResolution.siteId,
      contentType,
      operation: args.operation,
      contract: contractResolution.contract,
      manifest: contractResolution.manifest
    } as const;

    const prepared = prepareContractWriteRequest(args.input, context, resolvedType.restBase);

    return {
      ...prepared,
      contractResolution
    };
  }

  if (args.input.fields) {
    const compatibilityMessage =
      contractResolution.message ||
      (contractResolution.status === 'not_contract_backed'
        ? `Structured fields are only supported for contract-backed content types. ${contentType} does not currently publish a compatible contract.`
        : `Structured fields are not available for ${contentType} because the contract could not be resolved or executed.`);

    throw new ContractCompatibilityError(compatibilityMessage, {
      content_type: contentType,
      contract_status: contractResolution.status,
      site_id: contractResolution.siteId,
      manifest_issues: contractResolution.issues,
      execution_issues: contractResolution.executionSupport.issues
    });
  }

  logToFile(`Using generic write path for ${contentType} on site ${contractResolution.siteId}`);

  return {
    endpoint: resolvedType.restBase,
    fallbackOn404: getDefensiveEndpointFallback({
      contentType,
      provider: contractResolution.manifest?.provider,
      endpoint: resolvedType.restBase
    }),
    data: buildBaseContentPayload(args.input, args.operation),
    contractResolution
  };
}

export async function prepareContentDeleteRequest(
  args: PrepareContentDeleteRequestArgs
): Promise<PreparedContentDeleteRequest> {
  const resolvedType = await resolveContentType(args.contentType, args.siteId, args.contentTypeResolver, {
    forceRefresh: args.refreshCache
  });
  const contractResolution = await resolveContentTypeContract(
    resolvedType.slug,
    args.siteId,
    args.refreshCache
  );

  return buildContentDeleteRequest({
    contentType: resolvedType.slug,
    id: args.id,
    force: args.force,
    contractResolution,
    endpoint: resolvedType.restBase
  });
}

export function attachContentIdToPreparedRequest(
  preparedRequest: PreparedContentRequest,
  id: number
): PreparedContentRequest {
  return {
    ...preparedRequest,
    endpoint: appendEndpointId(preparedRequest.endpoint, id),
    fallbackOn404: preparedRequest.fallbackOn404
      ? {
          ...preparedRequest.fallbackOn404,
          endpoint: appendEndpointId(preparedRequest.fallbackOn404.endpoint, id)
        }
      : undefined
  };
}

export function buildContentDeleteRequest(
  args: BuildContentDeleteRequestArgs
): PreparedContentDeleteRequest {
  assertContractSupportsOperation(args.contractResolution, 'delete');

  const fallbackEndpoint = args.endpoint || getContentEndpoint(args.contentType);
  let endpoint = fallbackEndpoint;
  let namespace: string | undefined;
  let fallbackOn404: PreparedContentRequest['fallbackOn404'];
  let data: Record<string, unknown> = { force: args.force || false };

  if (args.contentType === EVENTON_EVENTS_CONTENT_TYPE) {
    // EventON events delete through APIfy first, keyed on the content type alone
    // (like reads), so the plugin's delete toggle and hooks apply. APIfy always
    // trashes and takes no `force`; the native wp/v2 route is the fallback when
    // the APIfy namespace is missing (404) and honors `force` there.
    endpoint = EVENTON_APIFY_EVENTS_ENDPOINT;
    namespace = EVENTON_APIFY_NAMESPACE;
    data = {};
    fallbackOn404 = {
      endpoint: fallbackEndpoint === EVENTON_APIFY_EVENTS_ENDPOINT ? EVENTON_EVENTS_CONTENT_TYPE : fallbackEndpoint,
      namespace: 'wp/v2',
      data: { force: args.force || false }
    };
  } else if (args.contractResolution.contract?.preferred_endpoint && args.contractResolution.manifest) {
    const split = splitNamespacedEndpoint(
      args.contractResolution.contract.preferred_endpoint,
      fallbackEndpoint
    );
    endpoint = split.endpoint;
    namespace = split.namespace;
    fallbackOn404 = getDefensiveEndpointFallback({
      contentType: args.contentType,
      provider: args.contractResolution.manifest.provider,
      endpoint,
      namespace
    });
  } else {
    fallbackOn404 = getDefensiveEndpointFallback({
      contentType: args.contentType,
      provider: args.contractResolution.manifest?.provider,
      endpoint
    });
  }

  const preparedRequest: PreparedContentRequest = {
    endpoint,
    namespace,
    fallbackOn404,
    data
  };

  return {
    ...attachContentIdToPreparedRequest(preparedRequest, args.id),
    contractResolution: args.contractResolution
  };
}

/**
 * Refuses operations a resolved contract cannot serve, with a clear error rather
 * than a request to a literal `{param}` path or a route that does not exist:
 * read-only contracts (e.g. event_rsvps) never take writes, and an operation
 * must be listed in supported_operations when the contract publishes that list. `delete` is not required to be listed
 * for ajde_events because EventON APIfy 3.5.1 manifests omitted it while the
 * route already existed.
 */
export function assertContractSupportsOperation(
  contractResolution: ContractResolution,
  operation: 'create' | 'update' | 'delete'
): void {
  const contract = contractResolution.contract;
  if (!contract || !contractResolution.manifest) {
    return;
  }

  const operations = contract.supported_operations;
  const readOnly = contract.preferred_write_mode === 'read_only';
  const listed = operations ? operations.includes(operation) : true;
  const legacyEventDelete = operation === 'delete' && contractResolution.contentType === EVENTON_EVENTS_CONTENT_TYPE;

  if (readOnly || (!listed && !legacyEventDelete)) {
    const reason = readOnly
      ? 'its contract is read-only'
      : `its contract does not list \`${operation}\` in supported_operations`;
    throw new ContractCompatibilityError(
      `Cannot ${operation} ${contractResolution.contentType}: ${reason}` +
        (operations ? ` (supported operations: ${operations.join(', ') || 'none'}).` : '.'),
      {
        content_type: contractResolution.contentType,
        site_id: contractResolution.siteId,
        operation,
        supported_operations: operations,
        preferred_write_mode: contract.preferred_write_mode,
        parent_context: contract.parent_context
      }
    );
  }
}

export function formatContractError(error: unknown): string {
  if (error instanceof ContractValidationError || error instanceof ContractCompatibilityError) {
    return JSON.stringify(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      },
      null,
      2
    );
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
