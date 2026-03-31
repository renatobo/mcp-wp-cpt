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
import { getContentEndpoint, getDefensiveEndpointFallback } from './utils.js';
import { buildBaseContentPayload } from './payloads.js';

export interface PrepareContentWriteRequestArgs {
  operation: 'create' | 'update';
  contentType: string;
  siteId?: string;
  input: AdaptedWriteInput;
  refreshCache?: boolean;
}

export interface PreparedContentWriteRequest extends PreparedContentRequest {
  contractResolution: ContractResolution;
}

export async function prepareContentWriteRequest(
  args: PrepareContentWriteRequestArgs
): Promise<PreparedContentWriteRequest> {
  const contractResolution = await resolveContentTypeContract(
    args.contentType,
    args.siteId,
    args.refreshCache
  );

  if (
    contractResolution.status === 'supported' &&
    contractResolution.contract &&
    contractResolution.manifest
  ) {
    logToFile(`Using contract interpreter for ${args.contentType} on site ${contractResolution.siteId}`);
    const context = {
      siteId: contractResolution.siteId,
      contentType: args.contentType,
      operation: args.operation,
      contract: contractResolution.contract,
      manifest: contractResolution.manifest
    } as const;

    const prepared = prepareContractWriteRequest(args.input, context);

    return {
      ...prepared,
      contractResolution
    };
  }

  if (args.input.fields) {
    const compatibilityMessage =
      contractResolution.message ||
      (contractResolution.status === 'not_contract_backed'
        ? `Structured fields are only supported for contract-backed content types. ${args.contentType} does not currently publish a compatible contract.`
        : `Structured fields are not available for ${args.contentType} because the contract could not be resolved or executed.`);

    throw new ContractCompatibilityError(compatibilityMessage, {
      content_type: args.contentType,
      contract_status: contractResolution.status,
      site_id: contractResolution.siteId,
      manifest_issues: contractResolution.issues,
      execution_issues: contractResolution.executionSupport.issues
    });
  }

  logToFile(`Using generic write path for ${args.contentType} on site ${contractResolution.siteId}`);

  return {
    endpoint: getContentEndpoint(args.contentType),
    fallbackOn404: getDefensiveEndpointFallback({
      contentType: args.contentType,
      provider: contractResolution.manifest?.provider,
      endpoint: getContentEndpoint(args.contentType)
    }),
    data: buildBaseContentPayload(args.input, args.operation),
    contractResolution
  };
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
