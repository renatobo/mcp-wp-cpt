import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/wordpress.js', () => ({
  makeWordPressRequest: vi.fn()
}));

import { makeWordPressRequest } from '../../src/wordpress.js';
import { getPluginEndpoint, pluginHandlers } from '../../src/tools/plugins.js';

const requestMock = vi.mocked(makeWordPressRequest);

describe('WordPress plugin tools', () => {
  beforeEach(() => {
    requestMock.mockResolvedValue({ plugin: 'akismet/akismet.php', status: 'active' });
  });

  it('URL-encodes plugin file identifiers', () => {
    expect(getPluginEndpoint('akismet/akismet.php')).toBe('plugins/akismet%2Fakismet.php');
  });

  it('activates through the core plugin update endpoint', async () => {
    await pluginHandlers.activate_plugin({ plugin: 'akismet/akismet.php', site_id: 'staging' });

    expect(requestMock).toHaveBeenCalledWith(
      'POST',
      'plugins/akismet%2Fakismet.php',
      { status: 'active' },
      { siteId: 'staging' }
    );
  });

  it('deactivates through the core plugin update endpoint', async () => {
    await pluginHandlers.deactivate_plugin({ plugin: 'akismet/akismet.php' });

    expect(requestMock).toHaveBeenCalledWith(
      'POST',
      'plugins/akismet%2Fakismet.php',
      { status: 'inactive' },
      { siteId: undefined }
    );
  });
});
