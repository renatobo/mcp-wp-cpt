import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSiteForContentUrl,
  resolveWriteInput,
  verifyEventONWrite
} from '../src/tools/unified-content.js';
import {
  EventONWriteUnverifiedError,
  formatEventONWriteUnverifiedError
} from '../src/content/eventon-write-verification.js';

const rawFetch = (raw: string) => async () => raw;

const editParams = (content_edit: Record<string, unknown>) => ({
  content_type: 'post',
  id: 42,
  content_edit
}) as any;

// Q-001: content_edit values must not be wrapped in <p> before splicing.
test('resolveWriteInput splices a plain-text replace verbatim in auto format', async () => {
  const result = await resolveWriteInput(
    editParams({ operation: 'replace', target_text: 'OLD', value: 'NEW', content_format: 'auto' }),
    rawFetch('<p>price: OLD</p>')
  );
  assert.equal(result.content, '<p>price: NEW</p>');
  assert.equal((result as any).content_edit, undefined);
});

test('resolveWriteInput does not run markdown-looking auto fragments through marked', async () => {
  const result = await resolveWriteInput(
    editParams({ operation: 'insert_after', target_text: 'Price:', value: ' *now* $10' }),
    rawFetch('<p>Price: TBD</p>')
  );
  assert.equal(result.content, '<p>Price: *now* $10 TBD</p>');
});

test('resolveWriteInput appends explicit html verbatim', async () => {
  const result = await resolveWriteInput(
    editParams({ operation: 'append', value: '\n<p>Update: open.</p>', content_format: 'html' }),
    rawFetch('<p>Body</p>')
  );
  assert.equal(result.content, '<p>Body</p>\n<p>Update: open.</p>');
});

test('resolveWriteInput converts plain-text appends to a paragraph in auto format', async () => {
  const result = await resolveWriteInput(
    editParams({ operation: 'append', value: 'Update: open.' }),
    rawFetch('<p>Body</p>')
  );
  assert.equal(result.content, '<p>Body</p><p>Update: open.</p>');
});

test('resolveWriteInput converts markdown prepends to block HTML in auto format', async () => {
  const result = await resolveWriteInput(
    editParams({ operation: 'prepend', value: '## Heading\n\nSome **bold** text.' }),
    rawFetch('<p>Body</p>')
  );
  assert.match(result.content as string, /^<h2[^>]*>Heading<\/h2>\s*<p>Some <strong>bold<\/strong> text\.<\/p>\s*<p>Body<\/p>$/);
});

test('resolveWriteInput converts auto fragments when the target is block-level', async () => {
  const result = await resolveWriteInput(
    editParams({ operation: 'insert_after', target_text: '<p>Body</p>', value: 'Next line.' }),
    rawFetch('<p>Body</p>')
  );
  assert.equal(result.content, '<p>Body</p><p>Next line.</p>');
});

test('resolveWriteInput converts explicit markdown and strips the <p> wrapper for inline replace', async () => {
  const result = await resolveWriteInput(
    editParams({ operation: 'replace', target_text: 'OLD', value: '**NEW**', content_format: 'markdown' }),
    rawFetch('<p>price: OLD</p>')
  );
  assert.equal(result.content, '<p>price: <strong>NEW</strong></p>');
});

test('resolveWriteInput keeps block markup for explicit markdown appends', async () => {
  const result = await resolveWriteInput(
    editParams({ operation: 'append', value: '**NEW**', content_format: 'markdown' }),
    rawFetch('<p>Body</p>')
  );
  assert.match(result.content as string, /^<p>Body<\/p><p><strong>NEW<\/strong><\/p>\s*$/);
});

// Q-004: URL host must pick (or be checked against) the configured site.
const sites = [
  { id: 'production', url: 'https://example.com' },
  { id: 'staging', url: 'https://staging.example.com/' }
];

test('resolveSiteForContentUrl picks the site whose host matches the URL', () => {
  assert.deepEqual(
    resolveSiteForContentUrl('https://staging.example.com/about/', undefined, sites),
    { ok: true, siteId: 'staging' }
  );
  assert.deepEqual(
    resolveSiteForContentUrl('https://WWW.Example.com/about/', undefined, sites),
    { ok: true, siteId: 'production' }
  );
});

test('resolveSiteForContentUrl rejects an explicit site_id that contradicts the URL host', () => {
  const result = resolveSiteForContentUrl('https://staging.example.com/about/', 'production', sites);
  assert.equal(result.ok, false);
  assert.match((result as any).error, /staging/);
});

test('resolveSiteForContentUrl errors on an unknown host with several sites unless site_id is explicit', () => {
  const implicit = resolveSiteForContentUrl('https://other.org/about/', undefined, sites);
  assert.equal(implicit.ok, false);

  const explicit = resolveSiteForContentUrl('https://other.org/about/', 'staging', sites);
  assert.equal(explicit.ok, true);
  assert.equal((explicit as any).siteId, 'staging');
  assert.match((explicit as any).warning, /other\.org/);
});

test('resolveSiteForContentUrl proceeds with a warning on a host mismatch when only one site is configured', () => {
  const single = [{ id: 'production', url: 'https://cms.example.com' }];
  const result = resolveSiteForContentUrl('https://www.example-frontend.com/about/', undefined, single);
  assert.equal(result.ok, true);
  assert.equal((result as any).siteId, 'production');
  assert.match((result as any).warning, /example-frontend\.com/);

  assert.deepEqual(
    resolveSiteForContentUrl('https://cms.example.com/about/', undefined, single),
    { ok: true, siteId: 'production' }
  );
});

test('resolveSiteForContentUrl errors on an unparseable URL', () => {
  assert.equal(resolveSiteForContentUrl('not a url', undefined, sites).ok, false);
});

// Q-006: a post-write verification failure must report the written ID.
const eventInput = {
  content_type: 'ajde_events',
  fields: { start_date: '2026-09-10' }
};
const writeResponse = { id: 9876, link: 'https://example.com/events/bike-night/', status: 'draft' };

test('verifyEventONWrite reports a field mismatch with the created event ID', async () => {
  const request = (async () => ({ id: 9876, start_date: '' })) as any;

  await assert.rejects(
    verifyEventONWrite('create', eventInput, writeResponse, request),
    (error: unknown) => {
      assert.ok(error instanceof EventONWriteUnverifiedError);
      const message = formatEventONWriteUnverifiedError(error);
      const parsed = JSON.parse(message);
      assert.equal(parsed.id, 9876);
      assert.equal(parsed.link, writeResponse.link);
      assert.equal(parsed.status, 'draft');
      assert.equal(parsed.written, true);
      assert.match(parsed.verification_error, /start_date/);
      assert.match(parsed.instructions, /Do NOT call create_content again/);
      assert.match(parsed.instructions, /update_content .*id 9876/);
      return true;
    }
  );
});

test('verifyEventONWrite downgrades a failed read-back to a warning with the write response', async () => {
  const request = (async () => { throw new Error('Request failed with status code 404'); }) as any;

  const { response, warnings } = await verifyEventONWrite('update', eventInput, writeResponse, request);
  assert.deepEqual(response, writeResponse);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /9876/);
  assert.match(warnings[0], /404/);
});

test('verifyEventONWrite is a no-op for non-EventON content', async () => {
  const request = (async () => { throw new Error('should not be called'); }) as any;
  const { response, warnings } = await verifyEventONWrite('create', { content_type: 'post' }, writeResponse, request);
  assert.deepEqual(response, writeResponse);
  assert.deepEqual(warnings, []);
});

test('verifyEventONWrite checks a full APIfy write response without reading it back', async () => {
  const request = (async () => { throw new Error('should not be called'); }) as any;
  const fullResponse = { id: 9876, start_date: '2026-09-10', start_time: '18:30', end_date: '2026-09-10', end_time: '20:30' };

  const { response, warnings } = await verifyEventONWrite('create', eventInput, fullResponse, request);
  assert.deepEqual(response, fullResponse);
  assert.deepEqual(warnings, []);

  await assert.rejects(
    verifyEventONWrite('create', eventInput, { ...fullResponse, start_date: '2026-09-11' }, request),
    (error: unknown) => error instanceof EventONWriteUnverifiedError
  );
});

test('verifyEventONWrite skips verification when nothing verifiable was sent', async () => {
  const request = (async () => { throw new Error('should not be called'); }) as any;
  const { response, warnings } = await verifyEventONWrite('update', { content_type: 'ajde_events' }, { id: 5 }, request);
  assert.deepEqual(response, { id: 5 });
  assert.deepEqual(warnings, []);
});
