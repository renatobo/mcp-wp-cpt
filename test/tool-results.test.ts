import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolResult, toolError, toolSuccess } from '../src/mcp/tool-results.js';

test('normalizes JSON text into backward-compatible text and structured data', () => {
  const normalized = normalizeToolResult(toolSuccess({ id: 42, status: 'draft' }));

  assert.equal(normalized.isError, false);
  assert.deepEqual(normalized.structuredContent, { data: { id: 42, status: 'draft' } });
  assert.match((normalized.content[0] as { text: string }).text, /"id": 42/);
});

test('normalizes errors into structured error data', () => {
  const normalized = normalizeToolResult(toolError('updating content', new Error('denied')));

  assert.equal(normalized.isError, true);
  assert.deepEqual(normalized.structuredContent, {
    error: { message: 'Error updating content: denied' }
  });
});

test('centralized errors prefer the actionable WordPress response message', () => {
  const result = toolError('activating plugin', {
    message: 'Request failed with status code 403',
    response: { data: { message: 'Sorry, you are not allowed to manage plugins.' } }
  });

  assert.equal(
    result.toolResult.content[0].text,
    'Error activating plugin: Sorry, you are not allowed to manage plugins.'
  );
});
