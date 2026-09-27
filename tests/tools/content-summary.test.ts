import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/wordpress.js', () => ({
  makeWordPressRequest: vi.fn(),
  logToFile: vi.fn()
}));

vi.mock('../../src/config/site-manager.js', () => ({
  getRequestTimeoutMs: () => 30000,
  siteManager: {
    resolveSiteId: (siteId?: string) => siteId || 'production',
    getAllSites: () => [
      { id: 'production', url: 'https://example.com' },
      { id: 'staging', url: 'https://staging.example.com' }
    ]
  }
}));

import { makeWordPressRequest } from '../../src/wordpress.js';
import { contentSummaryHandlers } from '../../src/tools/content-summary.js';
import { clearContentTypeCache } from '../../src/content/content-types.js';

const requestMock = vi.mocked(makeWordPressRequest);

describe('get_content_summary URL host checks', () => {
  beforeEach(() => {
    clearContentTypeCache();
    requestMock.mockImplementation(async (_method: string, endpoint: string, params?: any, options?: any) => {
      if (endpoint === 'types') {
        return { post: { rest_base: 'posts' }, page: { rest_base: 'pages' } };
      }
      if (endpoint === 'posts' && params?.slug === 'about') {
        return [{ id: 5, slug: 'about' }];
      }
      if (endpoint === 'posts/5' && options?.rawResponse) {
        return { data: { id: 5, slug: 'about', title: { rendered: 'About' } } };
      }
      return [];
    });
  });

  it('rejects a URL whose host matches no configured site without making requests', async () => {
    const result = await contentSummaryHandlers.get_content_summary({
      url: 'https://unknown.example.org/about/',
      content_type: 'post'
    });

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toMatch(/does not match any configured site/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects an explicit site_id that contradicts the URL host', async () => {
    const result = await contentSummaryHandlers.get_content_summary({
      url: 'https://staging.example.com/about/',
      site_id: 'production',
      content_type: 'post'
    });

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toMatch(/belongs to configured site "staging"/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('looks up and fetches on the site the URL host belongs to', async () => {
    const result = await contentSummaryHandlers.get_content_summary({
      url: 'https://staging.example.com/about/',
      content_type: 'post'
    });

    expect(result.toolResult.isError).toBe(false);
    expect(JSON.parse(result.toolResult.content[0].text)).toMatchObject({ id: 5, title: 'About' });
    const siteIds = requestMock.mock.calls.map((call) => (call[3] as any)?.siteId);
    expect(siteIds.length).toBeGreaterThan(0);
    expect(siteIds.every((siteId) => siteId === 'staging')).toBe(true);
    expect(requestMock).toHaveBeenCalledWith('GET', 'posts/5', undefined, { siteId: 'staging', rawResponse: true });
  });
});
