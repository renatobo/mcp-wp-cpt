import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectContentItem,
  projectListItem,
  projectListResponse,
  toPlainTextExcerpt
} from '../src/content/projection.js';
import { toListQueryParams } from '../src/content/read-preparation.js';
import { findContentAcrossTypes, isSkippableSearchError, isSlugSearchableType } from '../src/tools/unified-content.js';

const wpPost = {
  id: 7,
  slug: 'hello',
  type: 'post',
  status: 'publish',
  date: '2026-01-01T00:00:00',
  modified: '2026-01-02T00:00:00',
  link: 'https://example.com/hello/',
  title: { rendered: 'Hello &amp; welcome' },
  excerpt: { rendered: `<p>${'word '.repeat(100)}</p>` },
  content: { rendered: '<p>Body</p>' },
  author: 1,
  featured_media: 0,
  categories: [3],
  tags: [9, 10],
  guid: { rendered: 'https://example.com/?p=7' },
  class_list: ['post-7'],
  meta: { foo: 'bar' },
  _links: { self: [{ href: 'https://example.com/wp-json/wp/v2/posts/7' }] }
};

test('projectListResponse returns compact items for wp/v2 arrays', () => {
  const [item] = projectListResponse([wpPost]) as any[];
  assert.deepEqual(Object.keys(item), [
    'id', 'slug', 'type', 'status', 'date', 'modified', 'link', 'title', 'excerpt', 'author', 'featured_media',
    'categories', 'tags'
  ]);
  assert.deepEqual(item.tags, [9, 10]);
  assert.equal(item.title, 'Hello &amp; welcome');
  assert.ok(item.excerpt.length <= 303);
  assert.ok(item.excerpt.endsWith('...'));
  assert.ok(!item.excerpt.includes('<p>'));
});

test('projectListResponse keeps envelope metadata and EventON summary keys', () => {
  const response = {
    total: 12,
    pages: 2,
    page: 1,
    per_page: 10,
    events: [{
      id: 3,
      title: 'Bike night',
      slug: 'bike-night',
      status: 'publish',
      link: 'https://example.com/events/bike-night/',
      start_at: '2026-10-01T18:00:00-07:00',
      end_at: '2026-10-01T21:00:00-07:00',
      timezone: 'America/Los_Angeles',
      location_name: 'Garage',
      location: { term_id: 4, name: 'Garage', address: '1 Main St' },
      description: '<p>Long body</p>',
      organizers: [{ term_id: 1 }]
    }]
  };

  const projected = projectListResponse(response) as any;
  assert.equal(projected.total, 12);
  assert.equal(projected.pages, 2);
  assert.deepEqual(projected.events[0], {
    id: 3,
    title: 'Bike night',
    status: 'publish',
    slug: 'bike-night',
    link: 'https://example.com/events/bike-night/',
    start_at: '2026-10-01T18:00:00-07:00',
    end_at: '2026-10-01T21:00:00-07:00',
    timezone: 'America/Los_Angeles',
    location: { term_id: 4, name: 'Garage' },
    organizers: [{ term_id: 1 }]
  });
});

test('projectListResponse keeps hierarchy keys for pages', () => {
  const [item] = projectListResponse([{ id: 2, type: 'page', parent: 1, menu_order: 3, content: { rendered: 'x' } }]) as any[];
  assert.deepEqual(item, { id: 2, type: 'page', parent: 1, menu_order: 3 });
});

test('projectListResponse honors fields "full" and explicit field arrays', () => {
  const response = [wpPost];
  assert.equal(projectListResponse(response, 'full'), response);
  assert.deepEqual(projectListResponse(response, ['id', 'content', 'missing']), [
    { id: 7, content: { rendered: '<p>Body</p>' } }
  ]);
  assert.deepEqual(projectListResponse({ total: 1, events: [{ id: 1, x: 2 }] }, ['x']), {
    total: 1,
    events: [{ x: 2 }]
  });
});

test('projectContentItem strips _links and guid by default only', () => {
  const item = projectContentItem({ ...wpPost, content_raw: 'raw' }) as any;
  assert.equal(item._links, undefined);
  assert.equal(item.guid, undefined);
  assert.deepEqual(item.content, wpPost.content);
  assert.equal(item.content_raw, 'raw');
  assert.equal(projectContentItem(wpPost, 'full'), wpPost);
  assert.deepEqual(projectContentItem(wpPost, ['id', 'slug']), { id: 7, slug: 'hello' });
});

test('projectListItem compacts a single slug-search match', () => {
  const item = projectListItem(wpPost) as any;
  assert.equal(item.content, undefined);
  assert.equal(item.id, 7);
});

test('toPlainTextExcerpt strips tags and decodes common entities', () => {
  assert.equal(toPlainTextExcerpt({ rendered: '<p>Tom &amp; Jerry&nbsp;&#8230;</p>\n' }), 'Tom & Jerry ...');
  assert.equal(toPlainTextExcerpt(undefined), '');
});

test('toListQueryParams never forwards tool-only params to WordPress', () => {
  assert.deepEqual(
    toListQueryParams({
      content_type: 'post',
      site_id: 'staging',
      refresh_cache: true,
      fields: ['id'],
      per_page: 5,
      search: undefined
    }),
    { per_page: 5 }
  );
});

// Q-012: per-type failures in the slug fan-out.
const axiosLike = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status }
});

test('isSkippableSearchError treats unknown types and 404s as skippable only', () => {
  assert.equal(isSkippableSearchError(new Error('Unknown content type "doc": not found')), true);
  assert.equal(isSkippableSearchError(new Error('Invalid content type "a/b"')), true);
  assert.equal(isSkippableSearchError(axiosLike(404)), true);
  assert.equal(isSkippableSearchError(axiosLike(401)), false);
  assert.equal(isSkippableSearchError(new Error('timeout of 30000ms exceeded')), false);
});

test('findContentAcrossTypes skips unknown types and still finds the match', async () => {
  const result = await findContentAcrossTypes('hello', ['docs', 'post'], undefined, {
    searchType: async (contentType) => {
      if (contentType === 'docs') throw new Error('Unknown content type "docs"');
      return { content: { id: 7 }, contentType };
    }
  });
  assert.deepEqual(result, { content: { id: 7 }, contentType: 'post' });
});

test('findContentAcrossTypes returns null when searched types simply have no match', async () => {
  const result = await findContentAcrossTypes('hello', ['docs', 'post', 'page'], undefined, {
    searchType: async (contentType) => {
      if (contentType === 'docs') throw new Error('Unknown content type "docs"');
      if (contentType === 'page') throw axiosLike(500);
      return null;
    }
  });
  assert.equal(result, null);
});

test('findContentAcrossTypes throws when no type could be searched because of auth errors', async () => {
  await assert.rejects(
    findContentAcrossTypes('hello', ['docs', 'post', 'page'], undefined, {
      searchType: async (contentType) => {
        if (contentType === 'docs') throw new Error('Unknown content type "docs"');
        throw axiosLike(401);
      }
    }),
    /Search could not be completed: .*post: Request failed with status code 401/
  );
});

test('findContentAcrossTypes applies the same rule in sequential mode', async () => {
  const previous = process.env.WORDPRESS_PARALLEL_SEARCH;
  process.env.WORDPRESS_PARALLEL_SEARCH = 'false';
  try {
    await assert.rejects(
      findContentAcrossTypes('hello', ['post'], undefined, {
        searchType: async () => { throw new Error('socket hang up'); }
      }),
      /Search could not be completed/
    );
  } finally {
    if (previous === undefined) delete process.env.WORDPRESS_PARALLEL_SEARCH;
    else process.env.WORDPRESS_PARALLEL_SEARCH = previous;
  }
});

test('projectListResponse projects RSVP attendees and drops custom fields by default', () => {
  const projected = projectListResponse({
    total: 1,
    attendees: [{ id: 5, full_name: 'Ada', email: 'ada@example.com', rsvp: 'yes', custom_fields: { a: 1 }, other_attendees: [] }]
  }) as any;
  assert.deepEqual(projected.attendees, [{ id: 5, full_name: 'Ada', email: 'ada@example.com', rsvp: 'yes' }]);
});

test('projectListItem detects EventON events by shape and keeps generic keys for posts', () => {
  const event = projectListItem({
    id: 1,
    title: 'Ride',
    start_date: '2026-01-01',
    event_status: 'scheduled',
    description: 'long',
    location: { term_id: 2, name: 'Pub', phone: '555', email: 'x@y.z', address: '1 Main' },
    organizers: [{ term_id: 3, name: 'DROC', slug: 'droc', email: 'o@x.y' }]
  }) as any;
  assert.deepEqual(event, {
    id: 1,
    title: 'Ride',
    start_date: '2026-01-01',
    event_status: 'scheduled',
    location: { term_id: 2, name: 'Pub' },
    organizers: [{ term_id: 3, name: 'DROC', slug: 'droc' }]
  });

  const post = projectListItem({ ...wpPost, start_at: 'x', location: 'y' }) as any;
  assert.equal(post.start_at, undefined);
  assert.equal(post.location, undefined);
});

test('isSlugSearchableType skips internal and non-listable types', () => {
  assert.equal(isSlugSearchableType('post', { rest_base: 'posts', rest_namespace: 'wp/v2' }), true);
  assert.equal(isSlugSearchableType('ajde_events', { rest_base: 'ajde_events' }), true);
  assert.equal(isSlugSearchableType('attachment', { rest_base: 'media' }), false);
  assert.equal(isSlugSearchableType('nav_menu_item', { rest_base: 'menu-items' }), false);
  assert.equal(isSlugSearchableType('wp_navigation', { rest_base: 'navigation' }), false);
  assert.equal(
    isSlugSearchableType('custom_face', { rest_base: 'font-families/(?P<font_family_id>[\\d]+)/font-faces' }),
    false
  );
  assert.equal(isSlugSearchableType('shop_item', { rest_base: 'items', rest_namespace: 'wc/v3' }), false);
});
