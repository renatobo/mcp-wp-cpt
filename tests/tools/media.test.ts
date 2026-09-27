import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/wordpress.js', () => ({
  makeWordPressRequest: vi.fn()
}));

import { makeWordPressRequest } from '../../src/wordpress.js';
import { mediaHandlers } from '../../src/tools/media.js';
import {
  guardedFetch,
  isBlockedAddress,
  LookupFn,
  RequestFn,
  validateOutboundUrl
} from '../../src/security/url-guard.js';
import { readAllowedUploadFile } from '../../src/security/upload-path-guard.js';

const requestMock = vi.mocked(makeWordPressRequest);

function lookupFrom(map: Record<string, string[]>): LookupFn {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::', '2002:a9fe:a9fe::1', '2002:c0a8:101::', '64:ff9b:1::8.8.8.8', '64:ff9b:1:ffff::1',
    '192.0.2.10', '198.51.100.7', '203.0.113.200', '::ffff:203.0.113.1'
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '2002:808:808::1', '192.0.3.1', '203.0.114.1'])(
    'allows %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  );
});

describe('validateOutboundUrl', () => {
  const lookup = lookupFrom({
    'public.example': ['93.184.216.34'],
    'internal.example': ['10.0.0.5'],
    'mixed.example': ['93.184.216.34', '192.168.0.10'],
    'v6local.example': ['fe80::1'],
    'mapped.example': ['::ffff:127.0.0.1']
  });

  it('allows a public hostname and returns the resolved addresses', async () => {
    const result = await validateOutboundUrl('https://public.example/a.png', { lookup, allowPrivate: false });
    expect(result.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it.each([
    'http://internal.example/x',
    'http://mixed.example/x',
    'http://v6local.example/x',
    'http://mapped.example/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/'
  ])('rejects %s', async (url) => {
    await expect(validateOutboundUrl(url, { lookup, allowPrivate: false })).rejects.toThrow(/non-public address/);
  });

  it('rejects non-http schemes', async () => {
    await expect(validateOutboundUrl('file:///etc/passwd', { lookup, allowPrivate: false })).rejects.toThrow(/http or https/);
    await expect(validateOutboundUrl('ftp://public.example/x', { lookup, allowPrivate: false })).rejects.toThrow(/http or https/);
  });

  it('allows private targets when opted in', async () => {
    await expect(validateOutboundUrl('http://internal.example/x', { lookup, allowPrivate: true })).resolves.toBeTruthy();
    await expect(validateOutboundUrl('http://127.0.0.1/x', { lookup, allowPrivate: true })).resolves.toBeTruthy();
  });
});

describe('guardedFetch', () => {
  const lookup = lookupFrom({
    'public.example': ['93.184.216.34'],
    'cdn.example': ['93.184.216.35'],
    'internal.example': ['10.0.0.5']
  });

  function fakeResponse(status: number, headers: Record<string, string> = {}, data = Buffer.from('ok')) {
    return { status, headers, data, config: {}, statusText: '' } as any;
  }

  it('disables automatic redirects, applies limits, and pins the validated address', async () => {
    const request = vi.fn<RequestFn>().mockResolvedValue(fakeResponse(200, { 'content-type': 'image/png' }));
    await guardedFetch('https://public.example/a.png', { lookup, request, allowPrivate: false, maxBytes: 1234, timeoutMs: 999 });

    const config = request.mock.calls[0][0];
    expect(config.maxRedirects).toBe(0);
    expect(config.maxContentLength).toBe(1234);
    expect(config.maxBodyLength).toBe(1234);
    expect(config.timeout).toBe(999);
    expect(config.proxy).toBe(false);
    await expect((config.lookup as any)('public.example', {})).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('follows a redirect to another public host', async () => {
    const request = vi.fn<RequestFn>()
      .mockResolvedValueOnce(fakeResponse(302, { location: 'https://cdn.example/b.png' }))
      .mockResolvedValueOnce(fakeResponse(200));
    const response = await guardedFetch('https://public.example/a.png', { lookup, request, allowPrivate: false });

    expect(response.status).toBe(200);
    expect(request.mock.calls[1][0].url).toBe('https://cdn.example/b.png');
  });

  it('rejects a redirect to a private host without requesting it', async () => {
    const request = vi.fn<RequestFn>().mockResolvedValueOnce(fakeResponse(301, { location: 'http://internal.example/secret' }));
    await expect(guardedFetch('https://public.example/a.png', { lookup, request, allowPrivate: false })).rejects.toThrow(/non-public/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect to the metadata IP', async () => {
    const request = vi.fn<RequestFn>().mockResolvedValueOnce(fakeResponse(302, { location: 'http://169.254.169.254/latest' }));
    await expect(guardedFetch('https://public.example/a.png', { lookup, request, allowPrivate: false })).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('stops after three redirects', async () => {
    const request = vi.fn<RequestFn>().mockResolvedValue(fakeResponse(302, { location: '/again' }));
    await expect(guardedFetch('https://public.example/a.png', { lookup, request, allowPrivate: false })).rejects.toThrow(/maximum of 3 redirects/);
    expect(request).toHaveBeenCalledTimes(4);
  });
});

describe('readAllowedUploadFile', () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-wp-media-')));
    allowed = path.join(root, 'allowed');
    outside = path.join(root, 'outside');
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    await fs.mkdir(path.join(allowed, '.hidden'));
    await fs.writeFile(path.join(allowed, 'photo.png'), 'png-bytes');
    await fs.writeFile(path.join(allowed, 'big.png'), Buffer.alloc(2048));
    await fs.writeFile(path.join(allowed, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(allowed, '.hidden', 'inner.png'), 'x');
    await fs.writeFile(path.join(allowed, 'noext'), 'x');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(allowed, 'escape.txt'));
    await fs.mkdir(path.join(allowed, 'sub'));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads a file inside an allowed directory', async () => {
    const result = await readAllowedUploadFile(path.join(allowed, 'photo.png'), { allowedDirs: allowed });
    expect(result.buffer.toString()).toBe('png-bytes');
  });

  it('is disabled when no directories are configured', async () => {
    await expect(readAllowedUploadFile(path.join(allowed, 'photo.png'), { allowedDirs: '' }))
      .rejects.toThrow(/WORDPRESS_MEDIA_UPLOAD_DIRS/);
  });

  it('rejects files outside the allowed directory', async () => {
    await expect(readAllowedUploadFile(path.join(outside, 'secret.txt'), { allowedDirs: allowed })).rejects.toThrow(/outside/);
  });

  it('rejects .. traversal', async () => {
    await expect(readAllowedUploadFile(path.join(allowed, '..', 'outside', 'secret.txt'), { allowedDirs: allowed }))
      .rejects.toThrow(/outside/);
  });

  it('rejects a symlink that escapes the allowed directory', async () => {
    await expect(readAllowedUploadFile(path.join(allowed, 'escape.txt'), { allowedDirs: allowed })).rejects.toThrow(/outside/);
  });

  it('rejects dotfiles and files in dot-directories', async () => {
    await expect(readAllowedUploadFile(path.join(allowed, '.env'), { allowedDirs: allowed })).rejects.toThrow(/hidden/);
    await expect(readAllowedUploadFile(path.join(allowed, '.hidden', 'inner.png'), { allowedDirs: allowed })).rejects.toThrow(/hidden/);
  });

  it('rejects extensionless files', async () => {
    await expect(readAllowedUploadFile(path.join(allowed, 'noext'), { allowedDirs: allowed })).rejects.toThrow(/no file extension/);
  });

  it('rejects files above the size cap', async () => {
    await expect(readAllowedUploadFile(path.join(allowed, 'big.png'), { allowedDirs: allowed, maxBytes: 1024 }))
      .rejects.toThrow(/byte limit/);
  });

  it('rejects directories', async () => {
    await fs.mkdir(path.join(allowed, 'dir.png'), { recursive: true });
    await expect(readAllowedUploadFile(path.join(allowed, 'dir.png'), { allowedDirs: allowed })).rejects.toThrow(/not a file/);
  });

  describe('create_media handler', () => {
    const originalDirs = process.env.WORDPRESS_MEDIA_UPLOAD_DIRS;

    beforeEach(() => {
      requestMock.mockResolvedValue({ id: 1 });
    });

    afterEach(() => {
      if (originalDirs === undefined) delete process.env.WORDPRESS_MEDIA_UPLOAD_DIRS;
      else process.env.WORDPRESS_MEDIA_UPLOAD_DIRS = originalDirs;
    });

    it('returns a clear error when local uploads are disabled', async () => {
      delete process.env.WORDPRESS_MEDIA_UPLOAD_DIRS;
      const result = await mediaHandlers.create_media({ file_path: path.join(allowed, 'photo.png') });
      expect(result.toolResult.isError).toBe(true);
      expect(result.toolResult.content[0].text).toMatch(/WORDPRESS_MEDIA_UPLOAD_DIRS/);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('uploads an allowed file using the title plus the source extension', async () => {
      process.env.WORDPRESS_MEDIA_UPLOAD_DIRS = allowed;
      const result = await mediaHandlers.create_media({ file_path: path.join(allowed, 'photo.png'), title: 'My Photo' });
      expect(result.toolResult.isError).toBe(false);
      const form = requestMock.mock.calls[0][2] as any;
      expect(form.getBuffer().toString()).toContain('filename="My_Photo.png"');
    });

    it('rejects a private source_url before any upload', async () => {
      const result = await mediaHandlers.create_media({ source_url: 'http://127.0.0.1:9000/admin' });
      expect(result.toolResult.isError).toBe(true);
      expect(result.toolResult.content[0].text).toMatch(/non-public address/);
      expect(requestMock).not.toHaveBeenCalled();
    });
  });
});
