import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface LegacyToolResult {
  toolResult: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}

const parseLastJsonContent = (content: Array<{ text: string }>): unknown => {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(content[index].text);
    } catch {
      // Warnings and human-readable messages remain available as text content.
    }
  }

  return content.length === 1 ? content[0].text : content.map((item) => item.text);
};

export const normalizeToolResult = (result: LegacyToolResult): CallToolResult => {
  const content = result.toolResult.content.map((item) => ({
    ...item,
    type: 'text' as const
  }));
  const isError = result.toolResult.isError === true;

  if (isError) {
    return {
      content,
      isError: true,
      structuredContent: {
        error: {
          message: content.map((item) => item.text).join('\n')
        }
      }
    };
  }

  return {
    content,
    isError: false,
    structuredContent: {
      data: parseLastJsonContent(content)
    }
  };
};

export const toolSuccess = (data: unknown): LegacyToolResult => ({
  toolResult: {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError: false
  }
});

const getErrorMessage = (error: unknown): string => {
  if (!error || typeof error !== 'object') return String(error);

  const candidate = error as {
    message?: unknown;
    response?: { data?: { message?: unknown } };
  };
  const responseMessage = candidate.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.length > 0) return responseMessage;
  if (typeof candidate.message === 'string' && candidate.message.length > 0) return candidate.message;
  return String(error);
};

export const toolError = (context: string, error: unknown): LegacyToolResult => {
  const message = getErrorMessage(error);
  return {
    toolResult: {
      content: [{ type: 'text', text: `Error ${context}: ${message}` }],
      isError: true
    }
  };
};
