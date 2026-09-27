import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/wordpress.js', () => ({
  makeWordPressRequest: vi.fn(),
  logToFile: vi.fn()
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { makeWordPressRequest } from '../../src/wordpress.js';
import { allTools } from '../../src/tools/index.js';
import { userHandlers } from '../../src/tools/users.js';
import { commentHandlers } from '../../src/tools/comments.js';
import { buildToolInputSchema, PASSTHROUGH_TOOL_NAMES } from '../../src/mcp/input-schema.js';

const requestMock = vi.mocked(makeWordPressRequest);

describe('users and comments tools site_id routing', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({});
  });

  const cases: Array<[string, () => Promise<unknown>, string, string, unknown]> = [
    ['list_users', () => userHandlers.list_users({ search: 'bob', site_id: 'staging' }), 'GET', 'users', { search: 'bob' }],
    ['get_user', () => userHandlers.get_user({ id: 5, site_id: 'staging' }), 'GET', 'users/5', { context: undefined }],
    ['create_user', () => userHandlers.create_user({ username: 'u', email: 'u@example.com', password: 'p', site_id: 'staging' }), 'POST', 'users', { username: 'u', email: 'u@example.com', password: 'p' }],
    ['update_user', () => userHandlers.update_user({ id: 5, name: 'N', site_id: 'staging' }), 'POST', 'users/5', { name: 'N' }],
    ['delete_user', () => userHandlers.delete_user({ id: 5, force: true, reassign: 1, site_id: 'staging' }), 'DELETE', 'users/5', { force: true, reassign: 1 }],
    ['list_comments', () => commentHandlers.list_comments({ post: 3, site_id: 'staging' }), 'GET', 'comments', { post: 3 }],
    ['get_comment', () => commentHandlers.get_comment({ id: 7, site_id: 'staging' }), 'GET', 'comments/7', undefined],
    ['create_comment', () => commentHandlers.create_comment({ post: 3, content: 'hi', site_id: 'staging' }), 'POST', 'comments', { post: 3, content: 'hi' }],
    ['update_comment', () => commentHandlers.update_comment({ id: 7, content: 'x', site_id: 'staging' }), 'POST', 'comments/7', { content: 'x' }],
    ['delete_comment', () => commentHandlers.delete_comment({ id: 7, force: true, site_id: 'staging' }), 'DELETE', 'comments/7', { force: true }]
  ];

  it.each(cases)('%s passes siteId and keeps site_id out of the request body', async (_name, call, method, endpoint, body) => {
    await call();
    expect(requestMock).toHaveBeenCalledWith(method, endpoint, body, { siteId: 'staging' });
  });

  it('exposes site_id on every users and comments tool', () => {
    const names = ['list_users', 'get_user', 'create_user', 'update_user', 'delete_user',
      'list_comments', 'get_comment', 'create_comment', 'update_comment', 'delete_comment'];
    for (const name of names) {
      const tool = allTools.find((t) => t.name === name);
      expect(tool?.inputSchema.properties, name).toHaveProperty('site_id');
    }
  });
});

describe('registered tool input schemas', () => {
  let client: Client;
  let listed: Awaited<ReturnType<Client['listTools']>>['tools'];

  beforeAll(async () => {
    // Mirrors the registration loop in src/server.ts (which cannot be imported
    // without starting the stdio transport).
    const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
    for (const tool of allTools) {
      server.registerTool(tool.name, {
        description: tool.description ?? '',
        inputSchema: buildToolInputSchema(tool.name, tool.inputSchema.properties as z.ZodRawShape)
      }, async (args: any) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }));
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    listed = (await client.listTools()).tools;
  });

  it('publishes properties and additionalProperties:false for strict tools', () => {
    const deleteUser = listed.find((t) => t.name === 'delete_user');
    expect(Object.keys(deleteUser?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['id', 'site_id']));
    expect(deleteUser?.inputSchema.additionalProperties).toBe(false);
  });

  it('keeps every tool schema populated (never collapsed to {})', () => {
    for (const tool of listed) {
      const source = allTools.find((t) => t.name === tool.name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name)
        .toEqual(Object.keys(source.inputSchema.properties ?? {}));
    }
  });

  it('rejects unknown keys on a strict tool', async () => {
    const result = await client.callTool({ name: 'delete_user', arguments: { id: 5, siteid: 'staging' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/siteid|Unrecognized/i);
  });

  it('forwards extra keys for passthrough tools like list_content', async () => {
    expect(PASSTHROUGH_TOOL_NAMES.has('list_content')).toBe(true);
    const result = await client.callTool({ name: 'list_content', arguments: { content_type: 'post', meta_key: 'x' } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toMatchObject({ content_type: 'post', meta_key: 'x' });
  });

  it('only allowlists tools that exist', () => {
    const names = new Set(allTools.map((t) => t.name));
    for (const name of PASSTHROUGH_TOOL_NAMES) {
      expect(names.has(name), name).toBe(true);
    }
  });
});
