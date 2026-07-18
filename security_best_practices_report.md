# Security Best-Practices Assessment

Assessment date: 2026-07-18  
Scope: `main` at `7400cee`, local stdio MCP server, TypeScript/Node.js, WordPress REST API client  
Method: source review, lockfile-aligned build/test, `npm audit`, and comparison with current MCP and WordPress documentation

## Executive summary

The server is appropriate for trusted, single-user development use, but it is not yet secure-by-default for broad production deployment or unattended agent use. The stdio-only transport and WordPress Application Password authentication are good foundations. The most important risks are credential disclosure through debug logs, unrestricted local-file ingestion, unrestricted server-side URL fetching, and a powerful SQL tool whose client-side query filter is not a real security boundary.

No known vulnerable npm dependencies were reported by `npm audit` on 2026-07-18. This does not cover the application-level issues below.

## High severity

### SEC-001: WordPress credentials were included in debug request logs — resolved

- Location: `src/config/site-manager.ts:220-227`; `src/wordpress.ts:140-149`
- Resolution: request headers and nested sensitive payload keys are now passed through `redactSensitiveLogData()` before logging, with regression coverage in `test/log-redaction.test.ts`.
- Impact: setting `WORDPRESS_LOG_LEVEL=debug` writes reusable WordPress credentials to stderr. MCP hosts commonly capture server stderr, so logs can persist the credential or expose it to other support/observability systems.
- Fix: redact `authorization`, `cookie`, `set-cookie`, proxy authorization, and token-like headers before logging. Never log the client defaults object directly.
- Mitigation: keep the log level at its current `error` default and rotate Application Passwords after any debug session until redaction ships.
- False-positive notes: the default level is `error`, so this requires debug logging to be enabled; it is still an unsafe supported configuration.

### SEC-002: `create_media` can read and upload any file readable by the MCP process

- Location: `src/tools/media.ts:222-249`, especially `path.resolve(process.cwd(), filePath)` and `fs.readFile(resolvedPath)`.
- Evidence: `file_path` accepts absolute paths and unrestricted `..` traversal. There is no allowed-root policy, explicit consent token, size limit, or sensitive-file deny rule.
- Impact: a prompt-injected or mistakenly authorized tool call can exfiltrate SSH keys, environment files, source credentials, browser data, or other local files to WordPress. The MCP server runs with the host client's filesystem privileges.
- Fix: disable `file_path` by default or require an explicit configured upload root; resolve real paths, reject paths outside that root, reject symlinks escaping it, cap file size, and document the capability prominently.
- Mitigation: run the server in an OS sandbox/container with a minimal read-only filesystem and a dedicated upload directory.
- False-positive notes: stdio limits network callers, but it does not make model-originated tool arguments trustworthy.

### SEC-003: `create_media.source_url` permits SSRF and unbounded downloads

- Location: `src/tools/media.ts:197-204` and `252-269`.
- Evidence: validation checks only for `http:` or `https:`. Axios then follows the URL without blocking loopback, private/link-local addresses, cloud metadata, redirects to private destinations, oversized responses, or slow responses.
- Impact: a tool call can probe internal services, retrieve cloud metadata, or exhaust memory because the full response is buffered before upload.
- Fix: prefer a controlled egress proxy; otherwise resolve and block private/reserved address ranges on every redirect, require HTTPS by default, set strict connect/read timeouts, limit redirects and maximum body size, and stream to a bounded temporary file instead of buffering arbitrary responses.
- Mitigation: deny private-network egress at the process/container level and disable remote URL ingestion where it is not required.
- False-positive notes: private URLs may be a desired development feature; if so, make that an explicit opt-in rather than the default.

### SEC-004: SQL safety depends on a regex filter and an unspecified remote endpoint

- Location: `src/tools/sql-query.ts:16-26`, `47-103`; documentation at `README.md:656-668`.
- Evidence: the client attempts to recognize read-only SQL with prefixes and deny-list regexes, then forwards the original query to a custom endpoint. SQL parsing is context-sensitive; deny lists do not reliably constrain functions, expensive queries, file/database metadata access, comments/encoding, or dialect extensions. The repository does not contain the WordPress endpoint implementation, so its authorization, parser, limits, and database grants cannot be verified.
- Impact: depending on the remote implementation and database grants, an agent may extract secrets/PII, cause resource exhaustion, or bypass the intended read-only policy.
- Fix: make this tool disabled by default; require a companion endpoint that uses a database account restricted to explicit read-only views, enforces row/time limits server-side, and preferably exposes parameterized domain queries rather than arbitrary SQL. Treat the MCP-side filter only as UX validation.
- Mitigation: add explicit configuration such as `ENABLE_SQL_TOOL=true`, isolate the endpoint, restrict source IPs, and audit every invocation without logging sensitive result bodies.
- False-positive notes: the README claims `manage_options` is required, but the endpoint code is out of scope and could not be verified.

## Medium severity

### SEC-005: Destructive and privileged tools lacked MCP safety metadata — metadata resolved; capability minimization remains

- Location: tool arrays such as `src/tools/unified-content.ts:1058-1111`, `src/tools/plugins.ts:41-67`, `src/tools/users.ts:66-92`, and the unconditional registry in `src/tools/index.ts:15-25`.
- Resolution: every registered tool now includes `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, plus a structured output schema. Admin and high-risk tools are still exposed unconditionally, so configuration-based capability minimization remains open.
- Impact: MCP hosts have less information for consent UI and policy decisions, while least-privilege deployments cannot easily hide capabilities they do not need.
- Fix: annotate every tool and add configuration-based tool groups disabled by default for SQL, filesystem media, user administration, plugin management, and force-delete operations. Use separate least-privilege WordPress Application Password users where practical.
- Mitigation: configure the WordPress account with only required capabilities and require host-side approval for every mutating tool.
- False-positive notes: annotations are hints, not an authorization boundary, but they materially improve safe client behavior and operator clarity.

### SEC-006: Generic WordPress requests have no timeout, cancellation, or response-size ceiling

- Location: `src/config/site-manager.ts:222-228`; `src/wordpress.ts:121-151`.
- Evidence: the shared Axios client has no timeout or maximum response/body limits, and handlers do not consume MCP cancellation signals.
- Impact: a slow or malicious WordPress/plugin endpoint can hold a tool call indefinitely or return a response large enough to consume substantial memory and model context.
- Fix: configure bounded connect/read timeouts, response limits, cancellation propagation, and small retry policies only for idempotent reads with jitter and `Retry-After` handling.
- Mitigation: enforce egress timeouts and body limits in a proxy.
- False-positive notes: the SQL tool has a 30-second timeout, but the general client used by almost all tools does not.

### SEC-007: HTTP WordPress origins are accepted while using Basic authentication

- Location: environment examples and URL handling at `README.md:38-67`; client construction at `src/config/site-manager.ts:216-228`.
- Evidence: site URLs are not validated as HTTPS before a Basic Authorization header is attached.
- Impact: an `http://` configuration transmits the Application Password in a trivially reversible header without transport encryption.
- Fix: require HTTPS by default, with an explicit loopback-only development override. Validate the parsed URL once during configuration loading.
- Mitigation: ensure every configured site URL begins with `https://` and rotate credentials if HTTP has been used.
- False-positive notes: TLS may be supplied by a local trusted tunnel; that should require an explicit documented override.

## Low severity

### SEC-008: Error and response logging can retain sensitive WordPress content

- Location: `src/wordpress.ts:108-158` and `176-182`; `README.md:665`.
- Evidence: debug mode logs complete request and response bodies, and error mode logs the complete WordPress error response. These can include post contents, private metadata, user data, and plugin-specific secrets.
- Impact: sensitive content may be persisted in MCP host logs beyond its intended retention boundary.
- Fix: default to metadata-only logs (method, redacted origin/path, status, duration, request ID), with bounded and explicitly opted-in body sampling.
- Mitigation: protect and expire stderr logs; do not enable debug logging on production content.
- False-positive notes: body logging is useful during development, but should not be the general debug behavior for authenticated production APIs.

## Positive controls observed

- The production transport is stdio, limiting exposure to the spawning MCP client (`src/server.ts:69-72`).
- Protocol output is kept off stdout and covered by a startup test (`src/server.ts:58-72`; `test/startup-stdio.test.ts`).
- Tool inputs generally use Zod schemas and handlers consistently set `isError` for operational failures.
- WordPress Application Passwords are recommended instead of normal account passwords (`README.md:63-67`).
- The dependency tree is locked, the build succeeds, 60 tests pass with 2 integration tests skipped, and `npm audit` reported zero vulnerabilities on the assessment date.

## Recommended remediation order

1. Redact credentials and sensitive headers from logs.
2. Put local-file media, remote-URL media, SQL, plugin administration, and user administration behind explicit opt-in capability flags.
3. Sandbox file access and harden URL fetching against SSRF and resource exhaustion.
4. Replace the SQL security claim with a verifiable server-side least-privilege design.
5. Add MCP tool annotations and enforce HTTPS-by-default site configuration.
6. Add generic request timeouts, response limits, cancellation, and targeted integration/security tests.
