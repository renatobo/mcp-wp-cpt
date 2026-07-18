import axios, { AxiosInstance } from 'axios';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_WORDPRESS_7_INTEGRATION === 'true';
const siteUrl = process.env.WORDPRESS_7_TEST_URL;
const username = process.env.WORDPRESS_7_TEST_USERNAME;
const applicationPassword = process.env.WORDPRESS_7_TEST_PASSWORD;
const configured = enabled && Boolean(siteUrl && username && applicationPassword);

const restRoot = (url: string): string => `${url.replace(/\/$/, '').replace(/\/wp-json(?:\/.*)?$/, '')}/wp-json/`;

describe.skipIf(!configured)('WordPress 7 least-privilege integration', () => {
  let client: AxiosInstance;
  let postId: number | undefined;

  beforeAll(async () => {
    client = axios.create({
      baseURL: restRoot(siteUrl!),
      auth: {
        username: username!,
        password: applicationPassword!
      },
      timeout: 15_000,
      maxContentLength: 2 * 1024 * 1024,
      maxBodyLength: 2 * 1024 * 1024
    });

    const root = await client.get('');
    const generator = String(root.data?.generator ?? '');
    expect(generator, 'The integration target must report WordPress 7.x').toMatch(/wordpress\.org\/?\?v=7\./i);

    const currentUser = await client.get('wp/v2/users/me', { params: { context: 'edit' } });
    expect(currentUser.data?.id).toBeTypeOf('number');
  });

  afterAll(async () => {
    if (!postId) return;
    await client.delete(`wp/v2/posts/${postId}`, { params: { force: true } }).catch(() => undefined);
  });

  it('can perform an author-level draft post lifecycle', async () => {
    const marker = `mcp-wp-wp7-integration-${Date.now()}`;
    const created = await client.post('wp/v2/posts', {
      title: marker,
      content: '<p>WordPress 7 integration test. Safe to delete.</p>',
      status: 'draft'
    });
    postId = created.data.id;

    expect(postId).toBeTypeOf('number');
    expect(created.data.status).toBe('draft');

    const updated = await client.post(`wp/v2/posts/${postId}`, {
      excerpt: 'Updated by the WordPress 7 integration test.'
    });
    expect(updated.data.excerpt.raw).toContain('WordPress 7 integration test');

    const fetched = await client.get(`wp/v2/posts/${postId}`, { params: { context: 'edit' } });
    expect(fetched.data.title.raw).toBe(marker);

    const trashed = await client.delete(`wp/v2/posts/${postId}`, { params: { force: false } });
    expect(trashed.data.deleted).toBe(false);
  });

  it('cannot administer plugins or enumerate users', async () => {
    await expect(client.get('wp/v2/plugins')).rejects.toMatchObject({ response: { status: 403 } });
    await expect(client.get('wp/v2/users', { params: { context: 'edit' } })).rejects.toMatchObject({
      response: { status: 403 }
    });
  });
});
