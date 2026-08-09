import { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

const READ_ONLY_PREFIXES = ['list_', 'get_', 'discover_', 'describe_', 'search_', 'test_'];
const ADDITIVE_PREFIXES = ['create_'];
const IDEMPOTENT_PREFIXES = ['update_', 'activate_', 'deactivate_'];

const toTitle = (name: string): string =>
  name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const getToolAnnotations = (name: string): ToolAnnotations => {
  const readOnly = READ_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix)) || name === 'execute_sql_query';
  const additive = ADDITIVE_PREFIXES.some((prefix) => name.startsWith(prefix));
  const idempotent = IDEMPOTENT_PREFIXES.some((prefix) => name.startsWith(prefix));

  // This tool can optionally mutate content, so it cannot be advertised as read-only.
  if (name === 'find_content_by_url') {
    return {
      title: toTitle(name),
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    };
  }

  return {
    title: toTitle(name),
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : !additive,
    idempotentHint: readOnly || idempotent,
    openWorldHint: true
  };
};

export const TOOL_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    data: {},
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  additionalProperties: false
};

export const enrichToolDefinition = (tool: Tool): Tool => ({
  ...tool,
  annotations: tool.annotations ?? getToolAnnotations(tool.name),
  outputSchema: tool.outputSchema ?? TOOL_OUTPUT_SCHEMA
});
