// src/mcp/input-schema.ts
import { z } from 'zod';

// Tools whose module schema uses `.passthrough()` to forward arbitrary
// WordPress query params. Tool definitions only carry the raw zod shape
// (inputSchema.properties), so the module's strict/passthrough choice is not
// visible here and must be mirrored explicitly. Keep in sync with
// `grep -rn passthrough src/tools`.
export const PASSTHROUGH_TOOL_NAMES: ReadonlySet<string> = new Set([
    'list_content'
]);

// Builds the zod object registered with the MCP SDK. Passing a raw shape lets
// the SDK wrap it in a plain z.object, which silently strips unknown keys, so
// a misspelled or unsupported param (e.g. site_id on a tool without it) would
// run against the default site. Strict tools reject unknown keys instead.
export function buildToolInputSchema(toolName: string, rawShape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> {
    const base = z.object(rawShape);
    return (PASSTHROUGH_TOOL_NAMES.has(toolName) ? base.passthrough() : base.strict()) as z.ZodObject<z.ZodRawShape>;
}
