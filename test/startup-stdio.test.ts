import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('server loads dotenv quietly so MCP stdout remains JSON-RPC only', () => {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

  assert.match(source, /dotenv\.config\(\{\s*quiet:\s*true\s*\}\)/);
});
