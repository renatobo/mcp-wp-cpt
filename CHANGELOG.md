# Changelog

All notable changes to `@instawp/mcp-wp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **`content_type` can no longer redirect authenticated requests.** Content type identifiers must
  match `[A-Za-z0-9_-]+`, endpoints with `://`, a leading `//`, backslashes, or `.`/`..` segments are
  refused, and the per-site axios client sets `allowAbsoluteUrls: false`. Before, a value such as
  `https://attacker.example/x` (reachable from the read-only `list_content`) sent the site's Basic
  auth header to that host.
- **SSRF guard for `create_media.source_url`.** Only `http`/`https` is accepted and every redirect
  hop must resolve to public addresses (loopback, private, link-local, cloud metadata, CGNAT,
  multicast and reserved ranges are blocked). The connection is pinned to the validated address.
  `WORDPRESS_MEDIA_ALLOW_PRIVATE_URLS=true` allows private targets (e.g. a local dev site), and
  `WORDPRESS_MEDIA_MAX_BYTES` caps download size (default 50 MB).
- **BREAKING: `create_media.file_path` requires `WORDPRESS_MEDIA_UPLOAD_DIRS`.** Local uploads are
  disabled unless this comma-separated list of absolute directories is set. Paths are resolved with
  `realpath`, so `..` and symlinks cannot escape them; hidden, extensionless, and non-regular files
  are rejected.
- **BREAKING: Unknown tool parameters are rejected.** Tools register strict input schemas, so a misspelled or
  unsupported param (e.g. `site_id` on a tool without it) errors instead of silently running against
  the default site. `list_content` still forwards extra params to WordPress as query params.
- **`create_media.source_url` ignores `HTTP(S)_PROXY`.** Guarded downloads set `proxy: false`, since a
  proxy would resolve the target itself and bypass both address validation and pinning. Documentation
  ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), `64:ff9b:1::/48`, and 6to4
  (`2002::/16`) addresses embedding a blocked IPv4 are also blocked.
- **Encoded endpoint segments are decoded before the traversal check**, so `a/%2e%2e%2fusers` is
  refused; malformed percent-encoding is refused too.

### Changed
- **Content types resolve through the site's `/wp/v2/types`.** Custom post types whose `rest_base`
  differs from their slug now route correctly across content, taxonomy, and summary tools, and both
  the slug and the `rest_base` are accepted. Unknown content types now return an error listing the
  available types instead of being used as a raw path. EventON `ajde_events` still resolves when its
  manifest cannot be loaded and the type is missing from `/types` (EventON 5.x registers it with
  `show_in_rest=true` and rest_base `ajde_events`; older or filtered installs may not). The `/types` lookup is
  shared by all tools, concurrent lookups share one request, and unknown names are remembered for
  60 seconds so repeated misses do not refetch. `list_content` accepts `refresh_cache`.
- **Removed the on-disk content type cache.** `/types` responses are no longer written to
  `os.tmpdir()`, and `UNIFIED_CONTENT_CACHE_DIR` is no longer read. The cache is in memory only.
- **Request timeouts.** WordPress REST calls, the WordPress.org plugin search, and media downloads
  time out after `WORDPRESS_REQUEST_TIMEOUT_MS` (default 30000) instead of hanging indefinitely.
- **BREAKING: `list_content` returns compact summaries by default.** Each item keeps `id`, `slug`,
  `type`, `status`, `date`, `modified`, `link`, `title` (rendered string), `excerpt` (plain text, up to
  300 characters), `author`, `featured_media`, `parent`, `menu_order`, `categories`, `tags`. EventON
  events and RSVP attendees get their own summaries (see "EventON projection" below).
  Envelope metadata (`total`, `pages`) is kept. A new `fields` param takes `"full"` for the untouched
  response or an array of top-level keys. `get_content_by_slug` uses the same projection;
  `get_content` returns the full item minus `_links` and `guid`. The projection runs client-side,
  so `fields` is never sent to WordPress.
- **EventON list filtering is server-side only.** `list_content` for `ajde_events` no longer
  re-filters or re-sorts `eventonapify/v1/events` results client-side and never rewrites `total`,
  `pages`, `page`, or `per_page`. `orderby` is passed through (`date` maps to `created`; `start_at`,
  `created`, `modified`, and `title` are accepted). The `wp/v2` fallback receives the original
  params, so there `after`/`before` filter the WordPress publish date.
- **EventON lists warn about ignored params.** Params `eventonapify/v1/events` does not accept
  (`categories`, `tags`, `author`, `parent`, and any key outside its list or the manifest's
  `read_contract.filters`) are dropped from the APIfy request and reported in `_mcp_warnings`.
  APIfy has no tag filter.
- **EventON projection.** Compact event summaries keep `id`, `title`, `status`, `slug`, `link`,
  `excerpt`, `event_excerpt`, `event_subtitle`, start/end fields, `timezone`, `event_status`,
  `attendance_mode`, `event_type`, `tags`, `location` (`term_id`, `name`, `slug`, `city`, `state`,
  `country`), `organizers` (`term_id`, `name`, `slug`), `repeat`, `flags`, `time_extend_type`,
  `created`, `modified`, and `featured_media`. Events are detected by envelope or shape. RSVP
  `attendees` envelopes are projected to attendee summaries, and `extractContentCollection` reads
  them. wp/v2 items no longer carry EventON keys.
- **EventON deletes go through APIfy.** `delete_content` for `ajde_events` calls
  `DELETE eventonapify/v1/events/{id}` (respecting the plugin's delete toggle and hooks) and falls
  back to `wp/v2` on 404. APIfy always trashes; with `force: true` the result carries a warning.
- **Contract operation gating.** Writes and item reads on read-only or list-only contracts (e.g.
  `event_rsvps`) return a clear error instead of requesting a literal `{event_id}` path, and
  `assertRelativeEndpoint` rejects unresolved `{`/`}` template braces.
- **Contract interpreter accepts more manifest forms.** JSON-Schema type arrays (e.g. `lat`/`lon`
  as `["string", "number"]`), `also_accepts` hints (`number`, `comma_separated_string`, which splits
  a string into trimmed non-empty items), `one_of_required_for_<operation>` rules (e.g.
  `one_of_required_for_create: [["start_date", "start_at"]]`), and shorthand values valid after the
  declared coercion (e.g. a timezone string). A legacy required `start_date` (APIfy 3.5.1) is
  satisfied by `start_at`. Array item objects keep keys their shape does not declare, and tuple
  items such as a `[start, end]` repeat interval pass through.
- **EventON manifests may publish `eventonapify/v1/events` as `preferred_endpoint`**, as APIfy 3.5.2
  does. Both that and the 3.5.1 `wp/v2/ajde_events` form read and write through APIfy with the
  `wp/v2` read fallback. Verified against the manifest APIfy 3.5.2 generates, which also publishes
  `also_accepts`, `["string", "integer"]` term items, and numeric `lat`/`lon`, so comma-separated
  terms, numeric term IDs, and numeric coordinates pass client-side validation only on 3.5.2+.
- **Inline `content_edit` values are spliced verbatim.** In `auto` format, `replace`,
  `insert_before`, and `insert_after` on inline text no longer wrap the value in `<p>`, which nested
  paragraphs inside the edited content. `append`, `prepend`, and block-level targets still convert
  plain text and markdown to block HTML. Explicit `html` and `blocks` are verbatim for every
  operation; explicit `markdown` always converts.

### Fixed
- **`describe_content_type` no longer sends the contract twice.** `fields`, `validation_rules`, and
  `examples` appear once, under `contract.description`, and manifest issues once, under
  `manifest_cache`. Single-type manifest fields no longer carry a redundant one-entry `types` list.
  For EventON `ajde_events` the response drops from about 118 KB to 53 KB.
- **URL and slug search skips types without public URLs.** Attachments, menu items, core `wp_*`
  types (`wp_block`, `wp_template`, `wp_navigation`, `wp_font_face`, ...), types outside `wp/v2`, and
  types with templated `rest_base` values are no longer queried, which removes failed requests and
  ERROR log lines on every full search.
- **`find_content_by_url` and `get_content_summary` check the URL host.** The site is picked from the
  URL's host; a host matching several sites, a different site than the given `site_id`, or no site
  when several are configured is an error. With a single configured site, a non-matching host (e.g. a
  headless or CDN front end) is searched on that site with a warning. Before, a staging URL was looked up by slug on the default (production)
  site, and `find_content_by_url` could update it there.
- **Slug and URL searches report failed lookups.** Unknown types and 404s are skipped, but when no
  content type could be searched at all (e.g. 401, timeout, 5xx) the tools return an error instead
  of "No content found".
- **Users and comments tools honor `site_id`.** It was previously dropped, so every call ran against
  the default site.
- **Missing plugin namespaces reach the fallback.** The namespace probe run when a client is created
  now rethrows the original AxiosError (with an augmented message) and runs inside
  `makeWordPressRequest`'s error handling, so `retry404With` and the manifest `missing`
  classification work when a plugin namespace is absent. Failed clients are not cached.
- **EventON reads survive a disabled APIfy API.** Reads of `ajde_events` fall back to `wp/v2` on 403
  `eventon_apify_disabled` / `eventon_apify_capability_disabled`; writes stay strict. A disabled
  manifest is reported as `manifest_disabled` with an "API is disabled" message instead of a generic
  error.
- **`content_edit` and `include_raw_content` work for EventON events.** When an event comes from
  `eventonapify/v1` (no `content.raw`), its `description` is used as the raw body and `content_raw`,
  and the edited body is written back as `content`, which APIfy maps to `description`.
- **EventON write verification compares normalized values.** Times are compared as zero-padded
  `HH:MM` (`H:MM` and `HH:MM:SS` accepted), end date/time checks are skipped when `hide_end_time` is
  set without `span_hidden_end` (EventON pins the end), terms match by `term_id` when given and
  otherwise by name or sanitized slug, and an empty timezone is not compared. A full APIfy write
  response is verified directly without a second `GET`, and the no-manifest `wp/v2` write path no
  longer adds a read-back warning on every write.
- **`list_content` `rsvp` accepts `waitlist`.**
- **EventON unverified writes are reported as written.** When the read-back after an EventON
  create or update shows fields did not persist, the error says the event was written, gives its ID,
  and tells the caller to fix it with `update_content` instead of creating a duplicate. A failed
  read-back is reported as a warning.

### CI
- The test workflow runs `npx tsc --noEmit` before the tests.

## [0.2.0] - 2026-08-19

### Added
- **`WORDPRESS_USER_AGENT`.** Sets the user-agent on *every* outbound request — the WordPress REST
  client behind all tools, the SQL endpoint, both api.wordpress.org lookups, and remote media
  downloads. Unset (the default) keeps axios's own `axios/<version>`, so behaviour is unchanged
  unless you set it; an empty or whitespace-only value is treated as unset, since some edges block an
  empty user-agent too. For users behind a CDN/WAF that rejects the default. (#30)

### Changed
- **`execute_sql_query` explains an HTTP 403 instead of just reporting it.** A 403 may be WordPress
  rejecting the credentials *or* a CDN/WAF challenge page returned before the request reached
  WordPress; the error now says so, shows the response body (truncated) so the two can be told apart,
  and points at `WORDPRESS_USER_AGENT`. The bare `Request failed with status code 403` is what made
  #28 hard to diagnose. (#30)

### Security
- **Bumped `vitest` to `^4.1.11`** (dev dependency), clearing GHSA-5xrq-8626-4rwp — a critical
  advisory against `vitest < 3.2.6` (arbitrary file read/execute while the Vitest UI server is
  listening) — along with four moderate/high advisories in the bundled `vite` / `vite-node` /
  `esbuild` / `@vitest/mocker` chain. Dev-only: none of these ship in the published package.

## [0.1.2] - 2026-08-19

### Added
- **Automated npm publishing.** Pushing a `vX.Y.Z` tag now builds, tests and publishes the
  package with [provenance](https://docs.npmjs.com/generating-provenance-statements) via
  `.github/workflows/release.yml`, and verifies the registry actually serves the new version.
  Previously the package was published by hand, so a merged fix could sit unpublished
  indefinitely. See "Releasing" in the README. (#32)
- `repository`, `homepage` and `bugs` fields in `package.json` — the `repository` field is
  required for provenance and was missing. (#32)

### Note
- 0.1.1 was tagged and released on GitHub but never published to npm; this is the first
  published release containing the `execute_sql_query` User-Agent fix from #28.

## [0.1.1] - 2026-08-19

### Fixed
- **`execute_sql_query` no longer sends `User-Agent: Mozilla/5.0`.** The bare
  `Mozilla/5.0` is a well-known bot signature that CDNs/WAFs (WP Engine,
  Cloudflare bot protection) block with a 403 challenge page, so the tool failed
  against healthy, correctly authenticated SQL endpoints. It now sends no
  `User-Agent` override, matching every other tool in the package. (#28)

## [0.1.0] - 2026-06-15

### Added
- **Partial content edits.** `update_content` and `find_content_by_url` accept a
  `content_edit` object (`append`, `prepend`, `insert_before`, `insert_after`,
  `replace`) for targeted substring edits against the stored raw content instead
  of resending the whole document. Read tools gained `include_raw_content` (with a
  top-level `content_raw` alias) so callers can target the exact stored markup. (#26)
- **`get_content_summary` tool.** Returns a minimal, fixed-shape summary (id, title,
  slug, status, excerpt, taxonomy IDs, word count, Yoast SEO fields) by `id` or
  `url` — token-cheap for audit and lookup workflows. (#21)
- **Dropped-meta warnings.** `create_content`, `update_content`, and
  `find_content_by_url` now prepend a warning when WordPress silently drops meta
  keys that are not registered for REST (`show_in_rest`) — e.g. Yoast, Rank Math,
  or AIOSEO keys — so a no-op write is no longer reported as success. (#17)
- **Multi-site `site_id` for `execute_sql_query`.** Target a specific configured
  site in multi-site setups. (#25)
- **Test suite & CI.** Vitest setup with SiteManager and tool-registry coverage,
  plus a GitHub Actions workflow. (#18)

### Fixed
- **Taxonomy tools for divergent `rest_base`.** Taxonomies whose `rest_base`
  differs from their slug (e.g. `documentation_category` →
  `documentation-categories`) now resolve correctly via `/wp/v2/taxonomies`.
  `assign_terms_to_content` verifies the write against the WordPress response and
  reports an error instead of silently reporting success on a no-op write. (#23)
- **`execute_sql_query` endpoint URL.** Corrected from the wrong
  `…/wp-json/wp/v2/mcp/v1/query` to `…/wp-json/mcp/v1/query`, with hardened
  read-only validation. (#25)

### Changed
- **Response trimming.** `yoast_head` and `yoast_head_json` are stripped from REST
  responses by default (~10KB/response of rarely-used schema markup), configurable
  via the `MCP_WP_STRIP_FIELDS` environment variable. (#16)
- **BREAKING:** `assign_terms_to_content` `terms` now accepts only integer term IDs
  (`number[]`). Passing term slugs as strings is rejected at validation — WordPress
  only accepts term IDs on these REST fields, so string slugs were silently dropped
  before. (#23)

### Docs
- Documented meta-field limitations for SEO plugin keys. (#19)
- Documented WP Recipe Maker (WPRM) recipe-card support via `custom_fields`. (#20)

[Unreleased]: https://github.com/InstaWP/mcp-wp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/InstaWP/mcp-wp/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/InstaWP/mcp-wp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/InstaWP/mcp-wp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/InstaWP/mcp-wp/releases/tag/v0.1.0
