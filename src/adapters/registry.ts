import { siteManager } from '../config/site-manager.js';
import { loadSiteManifests } from './manifest-loader.js';
import { assessContractExecutionSupport } from './interpreter.js';
import {
  ContractResolution,
  ContentTypeContract,
  ProviderManifest
} from './types.js';

export async function resolveContentTypeContract(
  contentType: string,
  siteId?: string,
  refreshCache = false
): Promise<ContractResolution> {
  const resolvedSiteId = siteManager.resolveSiteId(siteId);
  const manifestResult = await loadSiteManifests(resolvedSiteId, refreshCache);

  for (const manifest of manifestResult.manifests) {
    const contract = manifest.contentTypes.find((entry) => entry.slug === contentType);
    if (!contract) {
      continue;
    }

    const executionSupport = assessContractExecutionSupport(contract);
    if (!executionSupport.executable) {
      return {
        siteId: resolvedSiteId,
        contentType,
        status: 'contract_incomplete',
        contract,
        manifest,
        issues: manifestResult.issues,
        executionSupport,
        message: `A contract exists for ${contentType}, but it is not executable by the generic interpreter.`
      };
    }

    return {
      siteId: resolvedSiteId,
      contentType,
      status: 'supported',
      contract,
      manifest,
      issues: manifestResult.issues,
      executionSupport
    };
  }

  const missingOrIncompatibleIssue = manifestResult.issues.find((issue) =>
    issue.status === 'missing' || issue.status === 'incompatible'
  );

  if (missingOrIncompatibleIssue) {
    return {
      siteId: resolvedSiteId,
      contentType,
      status: missingOrIncompatibleIssue.status === 'missing' ? 'manifest_missing' : 'manifest_incompatible',
      issues: manifestResult.issues,
      executionSupport: {
        executable: false,
        issues: [missingOrIncompatibleIssue.message]
      },
      message: missingOrIncompatibleIssue.message
    };
  }

  return {
    siteId: resolvedSiteId,
    contentType,
    status: 'not_contract_backed',
    issues: manifestResult.issues,
    executionSupport: {
      executable: false,
      issues: []
    }
  };
}

export async function listResolvedContentTypeContracts(
  siteId?: string,
  refreshCache = false
): Promise<Array<{ manifest: ProviderManifest; contract: ContentTypeContract; executable: boolean; execution_issues: string[] }>> {
  const resolvedSiteId = siteManager.resolveSiteId(siteId);
  const manifestResult = await loadSiteManifests(resolvedSiteId, refreshCache);

  return manifestResult.manifests.flatMap((manifest) =>
    manifest.contentTypes.map((contract) => {
      const executionSupport = assessContractExecutionSupport(contract);
      return {
        manifest,
        contract,
        executable: executionSupport.executable,
        execution_issues: executionSupport.issues
      };
    })
  );
}
