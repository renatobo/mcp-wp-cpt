import { buildBaseContentPayload } from '../content/payloads.js';
import {
  getContentEndpoint,
  getDefensiveEndpointFallback,
  splitNamespacedEndpoint
} from '../content/utils.js';
import {
  AdaptedWriteInput,
  ContentTypeContract,
  ContentTypeFieldDefinition,
  ContractExecutionSupport,
  ContractInterpreterContext,
  ContractValidationError,
  PreparedContentRequest
} from './types.js';

export function describeContractExecution(
  contract: ContentTypeContract,
  manifestProvider: string,
  manifestSchemaVersion: string,
  executionSupport: ContractExecutionSupport
): Record<string, unknown> {
  return {
    provider: manifestProvider,
    schema_version: manifestSchemaVersion,
    executable: executionSupport.executable,
    execution_issues: executionSupport.issues,
    preferred_write_mode: contract.preferred_write_mode || 'fields',
    preferred_endpoint: contract.preferred_endpoint || getContentEndpoint(contract.slug),
    supported_operations: contract.supported_operations || ['create', 'update'],
    fields: contract.fields || [],
    validation_rules: contract.validation_rules || {},
    examples: contract.examples || {}
  };
}

export function assessContractExecutionSupport(contract: ContentTypeContract): ContractExecutionSupport {
  const issues: string[] = [];
  const writeMode = contract.preferred_write_mode || 'fields';

  if (!contract.preferred_endpoint) {
    issues.push('Contract is missing `preferred_endpoint`.');
  }

  if (writeMode === 'fields' && (!contract.fields || contract.fields.length === 0)) {
    issues.push('Field-driven contracts must define `fields`.');
  }

  if (contract.fields) {
    for (const field of contract.fields) {
      collectFieldDefinitionIssues(field, issues, field.name);
    }
  }

  return {
    executable: issues.length === 0,
    issues
  };
}

export function prepareContractWriteRequest(
  input: AdaptedWriteInput,
  context: ContractInterpreterContext
): PreparedContentRequest {
  const payload = buildBaseContentPayload(input, context.operation);
  const writeMode = context.contract.preferred_write_mode || 'fields';
  const contractFields = context.contract.fields || [];
  const fields = input.fields || {};
  const validationIssues = validateStructuredFields(fields, contractFields, context);

  if (validationIssues.length > 0) {
    throw new ContractValidationError(
      'Structured contract fields are invalid',
      validationIssues,
      {
        content_type: context.contentType,
        provider: context.manifest.provider
      }
    );
  }

  if (Object.keys(fields).length > 0 && writeMode === 'fields') {
    Object.assign(payload, normalizeStructuredFields(fields, contractFields));
  }

  const endpointInfo = splitNamespacedEndpoint(
    context.contract.preferred_endpoint,
    getContentEndpoint(context.contentType)
  );

  return {
    endpoint: endpointInfo.endpoint,
    namespace: endpointInfo.namespace,
    fallbackOn404: getDefensiveEndpointFallback({
      contentType: context.contentType,
      provider: context.manifest.provider,
      endpoint: endpointInfo.endpoint,
      namespace: endpointInfo.namespace
    }),
    data: payload,
    warnings: []
  };
}

function collectFieldDefinitionIssues(
  field: ContentTypeFieldDefinition,
  issues: string[],
  path: string
) {
  if (!field.name) {
    issues.push(`Field definition at ${path} is missing a name.`);
  }

  if (field.type === 'object' && field.shape && field.shape.length === 0) {
    issues.push(`Object field ${path} has an empty shape definition.`);
  }

  if (field.type === 'array' && !field.items && field.coerce !== 'array_string_to_object_array') {
    const coercionType =
      typeof field.coerce === 'string'
        ? field.coerce
        : field.coerce && typeof field.coerce === 'object' && !Array.isArray(field.coerce) && typeof field.coerce.type === 'string'
          ? field.coerce.type
          : undefined;

    if (coercionType !== 'array_string_to_object_array') {
      issues.push(`Array field ${path} is missing an item definition or array coercion hint.`);
    }
  }

  if (field.shape) {
    for (const childField of field.shape) {
      collectFieldDefinitionIssues(childField, issues, `${path}.${childField.name}`);
    }
  }

  if (field.items) {
    collectFieldDefinitionIssues(field.items, issues, `${path}[]`);
  }
}

function validateStructuredFields(
  fields: Record<string, unknown>,
  fieldDefinitions: ContentTypeFieldDefinition[],
  context: ContractInterpreterContext
): string[] {
  const issues: string[] = [];
  const fieldMap = buildFieldMap(fieldDefinitions);
  const validationRules = context.contract.validation_rules || {};

  for (const key of Object.keys(fields)) {
    if (!fieldMap.has(key)) {
      issues.push(`\`fields.${key}\` is not defined by the contract.`);
    }
  }

  const requiredKeys = resolveRequiredKeys(fieldDefinitions, context.operation);
  for (const key of requiredKeys) {
    const definition = fieldMap.get(key);
    const value = definition ? readFieldValue(fields, definition) : undefined;
    if (value === undefined) {
      issues.push(`\`fields.${key}\` is required for ${context.operation}.`);
    }
  }

  const requiredByRule = getStringArray(validationRules, `required_for_${context.operation}`);
  for (const key of requiredByRule) {
    if (readFieldValueByKey(fields, fieldMap, key) === undefined) {
      issues.push(`\`fields.${key}\` is required for ${context.operation}.`);
    }
  }

  for (const group of getGroupRules(validationRules, 'required_together')) {
    const presentCount = group.filter((key) => readFieldValueByKey(fields, fieldMap, key) !== undefined).length;
    if (presentCount > 0 && presentCount !== group.length) {
      issues.push(`Fields ${group.map((key) => `\`fields.${key}\``).join(', ')} must be provided together.`);
    }
  }

  for (const group of getGroupRules(validationRules, 'one_of_required')) {
    const presentCount = group.filter((key) => readFieldValueByKey(fields, fieldMap, key) !== undefined).length;
    if (presentCount === 0) {
      issues.push(`At least one of ${group.map((key) => `\`fields.${key}\``).join(', ')} is required.`);
    }
  }

  for (const [key, value] of Object.entries(fields)) {
    const definition = fieldMap.get(key);
    if (!definition || value === undefined) {
      continue;
    }

    issues.push(...validateValueAgainstDefinition(value, definition, `fields.${key}`));
  }

  return issues;
}

function normalizeStructuredFields(
  fields: Record<string, unknown>,
  fieldDefinitions: ContentTypeFieldDefinition[]
): Record<string, unknown> {
  const fieldMap = buildFieldMap(fieldDefinitions);
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    const definition = fieldMap.get(key);
    if (!definition) {
      continue;
    }

    const targetKey = definition.write_key || definition.name;
    payload[targetKey] = normalizeFieldValue(value, definition);
  }

  return payload;
}

function normalizeFieldValue(value: unknown, definition: ContentTypeFieldDefinition): unknown {
  const normalizedByShape = normalizeValueByShape(value, definition);
  return applyCoercion(normalizedByShape, definition.coerce, definition);
}

function normalizeValueByShape(value: unknown, definition: ContentTypeFieldDefinition): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (definition.type === 'object' && definition.shape && isPlainObject(value)) {
    const nested: Record<string, unknown> = {};
    for (const childDefinition of definition.shape) {
      const childValue = readFieldValue(value, childDefinition);
      if (childValue !== undefined) {
        nested[childDefinition.write_key || childDefinition.name] = normalizeFieldValue(childValue, childDefinition);
      }
    }
    return nested;
  }

  if (definition.type === 'array' && Array.isArray(value) && definition.items) {
    return value.map((entry) => normalizeFieldValue(entry, definition.items!));
  }

  return value;
}

function applyCoercion(
  value: unknown,
  coerce: string | Record<string, unknown> | undefined,
  definition: ContentTypeFieldDefinition
): unknown {
  if (!coerce) {
    return value;
  }

  const coercion = typeof coerce === 'string' ? { type: coerce } : coerce;
  const coercionType = typeof coercion.type === 'string' ? coercion.type : undefined;

  if (!coercionType) {
    return value;
  }

  if ((coercionType === 'wrap_object' || coercionType === 'boolean_to_object' || coercionType === 'string_to_object') && value !== null && value !== undefined && !isPlainObject(value)) {
    const key = typeof coercion.key === 'string' ? coercion.key : 'value';
    return { [key]: value };
  }

  if (coercionType === 'boolean_to_object' && typeof value === 'boolean') {
    const key = typeof coercion.key === 'string' ? coercion.key : 'enabled';
    return { [key]: value };
  }

  if (coercionType === 'string_to_object' && typeof value === 'string') {
    const key = typeof coercion.key === 'string' ? coercion.key : 'name';
    return { [key]: value };
  }

  if (coercionType === 'array_string_to_object_array' && Array.isArray(value)) {
    const key = typeof coercion.key === 'string' ? coercion.key : 'name';
    return value.map((entry) =>
      typeof entry === 'string' ? { [key]: entry } : entry
    );
  }

  if (coercionType === 'map_values' && isPlainObject(coercion.values)) {
    const mapped = (coercion.values as Record<string, unknown>)[String(value)];
    return mapped !== undefined ? mapped : value;
  }

  return value;
}

function validateValueAgainstDefinition(
  value: unknown,
  definition: ContentTypeFieldDefinition,
  path: string
): string[] {
  const issues: string[] = [];

  if (definition.enum && definition.enum.length > 0 && !definition.enum.includes(value)) {
    issues.push(`\`${path}\` must be one of: ${definition.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`);
  }

  if (definition.type) {
    switch (definition.type) {
      case 'string':
      case 'date':
      case 'time':
        if (typeof value !== 'string') {
          issues.push(`\`${path}\` must be a string.`);
        }
        break;
      case 'number':
      case 'integer':
        if (typeof value !== 'number') {
          issues.push(`\`${path}\` must be a number.`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          issues.push(`\`${path}\` must be a boolean.`);
        }
        break;
      case 'object':
        if (!isPlainObject(value)) {
          issues.push(`\`${path}\` must be an object.`);
        } else if (definition.shape) {
          for (const childDefinition of definition.shape) {
            const childValue = readFieldValue(value, childDefinition);
            const childPath = `${path}.${childDefinition.name}`;
            if (childValue === undefined) {
              if (isFieldRequiredForOperation(childDefinition, 'create') || childDefinition.required) {
                issues.push(`\`${childPath}\` is required.`);
              }
              continue;
            }
            issues.push(...validateValueAgainstDefinition(childValue, childDefinition, childPath));
          }
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          issues.push(`\`${path}\` must be an array.`);
        } else if (definition.items) {
          value.forEach((entry, index) => {
            issues.push(...validateValueAgainstDefinition(entry, definition.items!, `${path}[${index}]`));
          });
        }
        break;
      default:
        break;
    }
  }

  return issues;
}

function resolveRequiredKeys(
  fieldDefinitions: ContentTypeFieldDefinition[],
  operation: 'create' | 'update'
): string[] {
  return fieldDefinitions
    .filter((definition) => isFieldRequiredForOperation(definition, operation))
    .map((definition) => definition.name);
}

function isFieldRequiredForOperation(
  definition: ContentTypeFieldDefinition,
  operation: 'create' | 'update'
): boolean {
  if (definition.required_on && definition.required_on.includes(operation)) {
    return true;
  }

  if (definition.operations && definition.required && definition.operations.includes(operation)) {
    return true;
  }

  return Boolean(definition.required && !definition.required_on);
}

function buildFieldMap(fieldDefinitions: ContentTypeFieldDefinition[]): Map<string, ContentTypeFieldDefinition> {
  const fieldMap = new Map<string, ContentTypeFieldDefinition>();

  for (const definition of fieldDefinitions) {
    fieldMap.set(definition.name, definition);
    for (const alias of definition.aliases || []) {
      fieldMap.set(alias, definition);
    }
  }

  return fieldMap;
}

function readFieldValue(
  value: Record<string, unknown>,
  definition: ContentTypeFieldDefinition
): unknown {
  if (Object.prototype.hasOwnProperty.call(value, definition.name)) {
    return value[definition.name];
  }

  for (const alias of definition.aliases || []) {
    if (Object.prototype.hasOwnProperty.call(value, alias)) {
      return value[alias];
    }
  }

  return undefined;
}

function readFieldValueByKey(
  value: Record<string, unknown>,
  fieldMap: Map<string, ContentTypeFieldDefinition>,
  key: string
): unknown {
  const definition = fieldMap.get(key);
  if (!definition) {
    return value[key];
  }

  return readFieldValue(value, definition);
}

function getStringArray(
  value: Record<string, unknown>,
  key: string
): string[] {
  const source = value[key];
  if (!Array.isArray(source)) {
    return [];
  }

  return source.filter((entry): entry is string => typeof entry === 'string');
}

function getGroupRules(
  value: Record<string, unknown>,
  key: string
): string[][] {
  const source = value[key];
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .map((group) => group.filter((entry): entry is string => typeof entry === 'string'))
    .filter((group) => group.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
