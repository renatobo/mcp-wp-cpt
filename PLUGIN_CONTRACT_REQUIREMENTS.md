# Plugin Contract Requirements

This document describes what a WordPress plugin must publish for `mcp-wp-cpt` to consume its custom content types through the generic contract interpreter.

The goal is simple:

- The plugin owns the content model.
- The MCP server reads that model from the plugin manifest.
- The server should not need plugin-specific normalization code.

## Overview

For a plugin content type to work with the current server, the plugin must:

1. Expose a read-only manifest endpoint under its own REST namespace.
2. Publish a `schema_version` compatible with the server.
3. Describe each supported content type in `content_types`.
4. Include enough execution metadata for the server to validate and normalize `fields`.
5. Keep the actual write target on the standard WordPress REST API, typically `wp/v2/...`.

The current server treats a contract as executable only when it can determine:

- which endpoint to write to
- which fields exist
- which fields are required
- how nested objects and arrays are shaped
- which coercions or transforms to apply before write

## Manifest Endpoint

The plugin should expose a read-only endpoint such as:

```text
/wp-json/<plugin-namespace>/v1/mcp-schema
```

Optional per-type expansion is also useful:

```text
/wp-json/<plugin-namespace>/v1/mcp-schema/<content_type>
```

Requirements:

- Must return JSON.
- Must be safe to fetch repeatedly.
- Must not expose secrets or writable routes.
- Must remain stable enough for caching.

## Top-Level Manifest Shape

Minimum required fields:

```json
{
  "schema_version": "1.0.0",
  "provider": "your-plugin-slug",
  "provider_version": "1.2.3",
  "content_types": {
    "your_cpt": {
      "slug": "your_cpt",
      "preferred_endpoint": "wp/v2/your_cpt",
      "preferred_write_mode": "fields",
      "supported_operations": ["create", "update"],
      "fields": []
    }
  }
}
```

Current server requirements:

- `schema_version` must be `1.x`.
- `content_types` must contain at least one content type.
- `preferred_endpoint` is required for executable contracts.
- `preferred_write_mode` should normally be `"fields"` for structured writes.

Notes:

- `content_types` may be an object keyed by slug or an array of content-type objects.
- `provider` and `provider_version` should always be present even though parsing is tolerant.

## Content Type Contract

Each content type should publish:

```json
{
  "slug": "ajde_events",
  "label": "Events",
  "description": "Structured event content",
  "preferred_endpoint": "wp/v2/ajde_events",
  "preferred_write_mode": "fields",
  "supported_operations": ["create", "update"],
  "fields": [],
  "validation_rules": {},
  "examples": {}
}
```

Meaning:

- `slug`: content type identifier used by the MCP tools.
- `preferred_endpoint`: write target. This is what the server POSTs to.
- `preferred_write_mode`: expected structured input mode. Use `"fields"` for normalized structured payloads.
- `supported_operations`: usually `create` and `update`.
- `fields`: executable field definitions.
- `validation_rules`: cross-field rules.
- `examples`: example payloads for clients and debugging.

## Field Definitions

Each field in `fields` should be defined with enough metadata for validation and normalization.

Supported field attributes:

- `name`: required canonical field name.
- `label`: optional display label.
- `description`: optional field description.
- `type`: supported values currently include `string`, `date`, `time`, `number`, `integer`, `boolean`, `object`, `array`.
- `required`: optional boolean.
- `required_on`: optional array such as `["create"]` or `["create", "update"]`.
- `write_key`: optional target key for the final `wp/v2` payload.
- `aliases`: optional alternate input names.
- `operations`: optional list of operations where this field applies.
- `enum`: optional allowed values list.
- `coerce`: optional transform hint.
- `shape`: optional nested field definitions for object fields.
- `items`: optional field definition for array items.

### Simple Field Example

```json
{
  "name": "start_date",
  "type": "string",
  "required_on": ["create"]
}
```

### Field With Write Mapping

```json
{
  "name": "location",
  "type": "object",
  "write_key": "event_location",
  "shape": [
    {
      "name": "name",
      "type": "string"
    }
  ]
}
```

### Array Field Example

```json
{
  "name": "organizers",
  "type": "array",
  "coerce": {
    "type": "array_string_to_object_array",
    "key": "name"
  }
}
```

## Supported Coercions

The current server supports these coercion hints:

- `boolean_to_object`
- `string_to_object`
- `wrap_object`
- `array_string_to_object_array`
- `map_values`

### `boolean_to_object`

Input:

```json
true
```

Definition:

```json
{
  "name": "virtual",
  "type": "boolean",
  "coerce": {
    "type": "boolean_to_object",
    "key": "enabled"
  }
}
```

Normalized output:

```json
{
  "enabled": true
}
```

### `string_to_object`

Definition:

```json
{
  "name": "organizer",
  "type": "string",
  "coerce": {
    "type": "string_to_object",
    "key": "name"
  }
}
```

### `array_string_to_object_array`

Definition:

```json
{
  "name": "organizers",
  "type": "array",
  "coerce": {
    "type": "array_string_to_object_array",
    "key": "name"
  }
}
```

Input:

```json
["Alice", "Bob"]
```

Normalized output:

```json
[
  { "name": "Alice" },
  { "name": "Bob" }
]
```

### `map_values`

Definition:

```json
{
  "name": "status",
  "type": "string",
  "coerce": {
    "type": "map_values",
    "values": {
      "live": "publish",
      "hidden": "draft"
    }
  }
}
```

## Nested Object And Array Shapes

Object fields should use `shape`:

```json
{
  "name": "location",
  "type": "object",
  "shape": [
    { "name": "name", "type": "string" },
    { "name": "address", "type": "string" }
  ]
}
```

Array fields should use `items` when the array elements are structured:

```json
{
  "name": "tickets",
  "type": "array",
  "items": {
    "name": "ticket",
    "type": "object",
    "shape": [
      { "name": "label", "type": "string" },
      { "name": "price", "type": "number" }
    ]
  }
}
```

## Validation Rules

The current server supports these cross-field rules in `validation_rules`:

- `required_for_create`
- `required_for_update`
- `required_together`
- `one_of_required`

Example:

```json
{
  "validation_rules": {
    "required_for_create": ["start_date", "start_time"],
    "required_together": [["end_date", "end_time"]],
    "one_of_required": [["location", "virtual"]]
  }
}
```

Meaning:

- `required_for_create`: each listed field is required on create.
- `required_for_update`: each listed field is required on update.
- `required_together`: if one field in a group is present, all must be present.
- `one_of_required`: at least one field in the group must be present.

## Examples

The plugin should publish examples for both create and update.

Recommended structure:

```json
{
  "examples": {
    "create": {
      "title": "Launch Party",
      "status": "draft",
      "fields": {
        "start_date": "2026-04-01",
        "start_time": "18:30",
        "location": {
          "name": "HQ"
        }
      }
    },
    "update": {
      "fields": {
        "location": {
          "name": "New Venue"
        }
      }
    }
  }
}
```

## Executability Checklist

A plugin contract is currently usable by the server when all of the following are true:

- top-level manifest is valid JSON
- `schema_version` is `1.x`
- at least one content type is present
- the target content type includes `preferred_endpoint`
- `preferred_write_mode` is compatible with structured writes
- structured fields are fully defined in `fields`
- object fields publish `shape`
- array fields publish `items` or a supported coercion
- cross-field requirements are published in `validation_rules`

If these are missing, the server will return a compatibility error instead of inventing plugin-specific behavior.

## Versioning Rules

Recommended:

- Use `schema_version` for manifest contract compatibility.
- Use `provider_version` for plugin release version.
- Keep `1.x` backward compatible when possible.
- Bump the major schema version only when older interpreters should refuse the contract.

## Backward Compatibility

The manifest is discovery-only.

That means:

- the plugin can keep its own custom namespace routes
- the server should still write to `wp/v2/...` unless the contract says otherwise
- the manifest should describe normalized fields, not force clients to understand low-level meta keys

## Recommendations For Plugin Authors

- Generate manifest data from the same internal definitions used by your runtime normalization code.
- Do not maintain a second handwritten schema copy.
- Publish examples that match real accepted `wp/v2` payloads.
- Prefer normalized field names over storage-specific keys.
- Include explicit coercion hints any time user-friendly input differs from the final REST payload shape.
- Test the manifest against a real MCP client flow, not only against plugin unit tests.

## EventON APIfy As The Reference Case

For EventON-style content, the plugin should publish normalized fields such as:

- `start_date`
- `start_time`
- `end_date`
- `end_time`
- `timezone`
- `location`
- `organizers`
- `flags`
- `virtual`
- `repeat`
- `rsvp`

But the plugin must also publish the execution semantics behind them:

- target keys
- nested object shapes
- array item shapes or coercions
- required groups
- enum constraints
- create/update examples

Without that, the server cannot remain generic.

## Current Limitation

The current server manifest discovery list is still explicit. A new plugin provider must either:

- expose a manifest endpoint already known to the server, or
- be added to the server discovery sources

That is separate from contract execution. This document covers what the plugin must publish once discovered.
