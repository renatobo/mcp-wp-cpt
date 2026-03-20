export type ContractWriteMode = 'generic' | 'fields' | 'custom_fields';
export type ContractOperation = 'create' | 'update';
export type ContractResolutionStatus =
  | 'supported'
  | 'not_contract_backed'
  | 'manifest_missing'
  | 'manifest_incompatible'
  | 'contract_incomplete';

export interface ContentTypeFieldDefinition {
  name: string;
  label?: string;
  description?: string;
  type?: string;
  required?: boolean;
  required_on?: string[];
  write_key?: string;
  aliases?: string[];
  operations?: string[];
  enum?: unknown[];
  coerce?: string | Record<string, unknown>;
  shape?: ContentTypeFieldDefinition[];
  items?: ContentTypeFieldDefinition;
  [key: string]: unknown;
}

export interface ContentTypeParentContext {
  content_type?: string;
  id_param?: string;
  [key: string]: unknown;
}

export interface ContentTypeContract {
  slug: string;
  label?: string;
  description?: string;
  preferred_endpoint?: string;
  preferred_write_mode?: string;
  supported_operations?: string[];
  parent_context?: ContentTypeParentContext;
  fields?: ContentTypeFieldDefinition[];
  validation_rules?: Record<string, unknown>;
  examples?: Record<string, unknown>;
  provider?: string;
  provider_version?: string;
  schema_version?: string;
  [key: string]: unknown;
}

export interface ProviderManifest {
  provider: string;
  provider_version?: string;
  schema_version: string;
  namespace: string;
  endpoint: string;
  source: string;
  contentTypes: ContentTypeContract[];
  raw: Record<string, unknown>;
}

export interface ManifestCompatibilityIssue {
  source: string;
  status: 'missing' | 'incompatible' | 'error';
  provider?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ManifestLoadResult {
  siteId: string;
  manifests: ProviderManifest[];
  issues: ManifestCompatibilityIssue[];
  fetchedAt: number;
  cacheHit: boolean;
}

export interface AdaptedWriteInput {
  title?: string;
  content?: string;
  status?: string;
  excerpt?: string;
  slug?: string;
  author?: number;
  parent?: number;
  categories?: number[];
  tags?: number[];
  featured_media?: number;
  format?: string;
  menu_order?: number;
  meta?: Record<string, unknown>;
  custom_fields?: Record<string, unknown>;
  fields?: Record<string, unknown>;
}

export interface ContractInterpreterContext {
  siteId: string;
  contentType: string;
  operation: ContractOperation;
  manifest: ProviderManifest;
  contract: ContentTypeContract;
}

export interface PreparedContentRequest {
  endpoint: string;
  namespace?: string;
  data: Record<string, unknown>;
  warnings?: string[];
}

export interface ContractExecutionSupport {
  executable: boolean;
  issues: string[];
}

export interface ContractResolution {
  siteId: string;
  contentType: string;
  status: ContractResolutionStatus;
  manifest?: ProviderManifest;
  contract?: ContentTypeContract;
  issues: ManifestCompatibilityIssue[];
  executionSupport: ContractExecutionSupport;
  message?: string;
}

export class ContractError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ContractValidationError extends ContractError {
  constructor(
    message: string,
    public readonly validationIssues: string[],
    details?: Record<string, unknown>
  ) {
    super(message, 'contract_validation_failed', {
      ...details,
      validation_issues: validationIssues
    });
  }
}

export class ContractCompatibilityError extends ContractError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'contract_compatibility_error', details);
  }
}
