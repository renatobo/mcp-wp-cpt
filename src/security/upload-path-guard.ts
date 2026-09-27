// src/security/upload-path-guard.ts
//
// Guard for create_media.file_path. Local uploads are disabled unless the operator
// lists allowed directories in WORDPRESS_MEDIA_UPLOAD_DIRS. The requested path is
// resolved with realpath (defeating `..` and symlink escapes) and must land inside
// one of the allowed directories, contain no dot-segments below it, be a regular
// file, carry an extension, and fit within the size cap.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveMaxBytes } from './url-guard.js';

export type LocalUploadFile = {
  realPath: string;
  buffer: Buffer;
};

export type UploadPathGuardOptions = {
  allowedDirs?: string;
  maxBytes?: number;
  cwd?: string;
};

async function resolveAllowedDirs(rawDirs: string | undefined) {
  const entries = (rawDirs ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error(
      'Local file uploads are disabled. Set WORDPRESS_MEDIA_UPLOAD_DIRS to a comma-separated list '
      + 'of absolute directories that create_media.file_path may read from.'
    );
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) {
      continue;
    }
    try {
      resolved.push(await fs.realpath(entry));
    } catch {
      // Missing or unreadable allowed dirs are skipped.
    }
  }

  if (resolved.length === 0) {
    throw new Error('WORDPRESS_MEDIA_UPLOAD_DIRS does not contain any existing absolute directory.');
  }

  return resolved;
}

function relativeInside(root: string, target: string) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

export async function readAllowedUploadFile(filePath: string, options: UploadPathGuardOptions = {}): Promise<LocalUploadFile> {
  const allowedDirs = await resolveAllowedDirs(options.allowedDirs ?? process.env.WORDPRESS_MEDIA_UPLOAD_DIRS);
  const maxBytes = options.maxBytes ?? resolveMaxBytes();
  const requestedPath = path.resolve(options.cwd ?? process.cwd(), filePath);

  let realPath: string;
  try {
    realPath = await fs.realpath(requestedPath);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw new Error(`Unable to access file_path '${filePath}': ${error.message}`);
  }

  let relative: string | null = null;
  for (const dir of allowedDirs) {
    relative = relativeInside(dir, realPath);
    if (relative) break;
  }

  if (!relative) {
    throw new Error(`file_path '${filePath}' is outside the directories allowed by WORDPRESS_MEDIA_UPLOAD_DIRS.`);
  }

  if (relative.split(path.sep).some((segment) => segment.startsWith('.'))) {
    throw new Error(`file_path '${filePath}' refers to a hidden file or directory, which cannot be uploaded.`);
  }

  if (!path.extname(realPath)) {
    throw new Error(`file_path '${filePath}' has no file extension; only files with an extension can be uploaded.`);
  }

  // Check before opening: opening a FIFO or device for reading can block or have side effects.
  const preStats = await fs.stat(realPath);
  if (!preStats.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }
  if (preStats.size > maxBytes) {
    throw new Error(`File is ${preStats.size} bytes, above the ${maxBytes} byte limit (WORDPRESS_MEDIA_MAX_BYTES).`);
  }

  const handle = await fs.open(realPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }
    if (stats.size > maxBytes) {
      throw new Error(`File is ${stats.size} bytes, above the ${maxBytes} byte limit (WORDPRESS_MEDIA_MAX_BYTES).`);
    }

    const buffer = await handle.readFile();
    if (buffer.length > maxBytes) {
      throw new Error(`File exceeds the ${maxBytes} byte limit (WORDPRESS_MEDIA_MAX_BYTES).`);
    }

    return { realPath, buffer };
  } finally {
    await handle.close();
  }
}
