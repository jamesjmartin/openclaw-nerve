/**
 * File browser API routes.
 *
 * Provides directory tree listing, file reading/writing, and file operations
 * for both workspace-relative and filesystem (absolute) scoped paths.
 * Path validation (traversal/exclusion rules) applies to both scopes.
 * Size limits and depth constraints are enforced where applicable.
 *
 * GET  /api/files/tree   — List directory entries (lazy, depth-limited)
 * GET  /api/files/read   — Read a text file's content
 * PUT  /api/files/write  — Write/update a text file
 * GET  /api/files/raw    — Serve raw file content
 * POST /api/files/rename — Rename a file or directory
 * POST /api/files/move   — Move a file or directory
 * POST /api/files/trash  — Move to trash (workspace-only)
 * POST /api/files/delete — Permanently delete (fs-scope only)
 * POST /api/files/restore— Restore from trash (workspace-only)
 * @module
 */

import { Hono, type Context } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Validate and parse scope parameter */
function parseScope(rawScope: string | undefined): 'workspace' | 'fs' | null {
  const scope = rawScope || 'workspace';
  if (scope === 'workspace' || scope === 'fs') {
    return scope;
  }
  return null;
}
import {
  getWorkspaceRoot,
  resolveWorkspacePath,
  resolveFsPath,
  isExcluded,
  isBinary,
  MAX_FILE_SIZE,
  toPosixPath,
} from '../lib/file-utils.js';
import {
  FileOpError,
  moveEntry,
  renameEntry,
  restoreEntry,
  trashEntry,
  deleteEntryPermanently,
} from '../lib/file-ops.js';

const app = new Hono();

// ── Types ────────────────────────────────────────────────────────────

interface TreeEntry {
  name: string;
  path: string;         // relative to workspace root
  type: 'file' | 'directory';
  size?: number;        // bytes, files only
  mtime?: number;       // epoch ms
  binary?: boolean;     // true for binary files
  children?: TreeEntry[] | null; // null = not loaded, [] = empty dir
}

// ── Helpers ──────────────────────────────────────────────────────────

async function listDirectory(
  dirPath: string,
  basePath: string,
  depth: number,
  scope: 'workspace' | 'fs' = 'workspace',
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];

  let items;
  try {
    items = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return entries;
  }

  // Sort: directories first, then alphabetical (case-insensitive)
  items.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  for (const item of items) {
    // Skip excluded names and hidden files (except specific ones)
    if (isExcluded(item.name)) continue;

    // Trash handling only applies to workspace scope (fs-scope paths are absolute, never '.trash')
    const inTrash = basePath === '.trash' || basePath.startsWith('.trash/');
    if (inTrash) {
      // Internal metadata file for restore bookkeeping.
      if (item.name === '.index.json') continue;
    } else if (scope === 'workspace') {
      // Workspace: hide dotfiles except specific ones
      if (item.name.startsWith('.') && item.name !== '.nerveignore' && item.name !== '.trash') {
        continue;
      }
    }
    // Filesystem scope: show all files including dotfiles

    const relativePath = scope === 'fs' 
      ? toPosixPath(path.join(dirPath, item.name))
      : toPosixPath(basePath ? path.join(basePath, item.name) : item.name);
    const fullPath = path.join(dirPath, item.name);

    if (item.isDirectory()) {
      entries.push({
        name: item.name,
        path: relativePath,
        type: 'directory',
        children: depth > 1
          ? await listDirectory(fullPath, relativePath, depth - 1, scope)
          : null,
      });
    } else if (item.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        entries.push({
          name: item.name,
          path: relativePath,
          type: 'file',
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs),
          binary: isBinary(item.name) || undefined,
        });
      } catch {
        // Skip files we can't stat
      }
    }
  }

  return entries;
}

function handleFileOpError(c: Context, err: unknown) {
  if (err instanceof FileOpError) {
    return c.json({ ok: false, error: err.message, code: err.code }, err.status);
  }
  const message = err instanceof Error ? err.message : 'Operation failed';
  return c.json({ ok: false, error: message }, 500);
}

// ── GET /api/files/tree ──────────────────────────────────────────────

app.get('/api/files/tree', async (c) => {
  const scope = parseScope(c.req.query('scope'));
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }
  const subPath = c.req.query('path') || '';
  const depth = Math.min(Math.max(Number(c.req.query('depth')) || 1, 1), 5);

  let targetDir: string;
  let rootPath: string;

  if (scope === 'fs') {
    // Filesystem scope: require absolute path
    if (!subPath) {
      return c.json({ ok: false, error: 'Filesystem scope requires absolute path' }, 400);
    }
    if (!path.isAbsolute(subPath)) {
      return c.json({ ok: false, error: 'Path must be absolute for filesystem scope' }, 400);
    }

    const resolved = await resolveFsPath(subPath);
    if (!resolved) {
      return c.json({ ok: false, error: 'Invalid or excluded path' }, 403);
    }
    targetDir = resolved;
    rootPath = resolved;

    // Ensure it's a directory
    try {
      const stat = await fs.stat(targetDir);
      if (!stat.isDirectory()) {
        return c.json({ ok: false, error: 'Not a directory' }, 400);
      }
    } catch {
      return c.json({ ok: false, error: 'Directory not found' }, 404);
    }
  } else {
    // Workspace scope: existing behavior
    const root = getWorkspaceRoot();
    if (subPath) {
      const resolved = await resolveWorkspacePath(subPath);
      if (!resolved) {
        return c.json({ ok: false, error: 'Invalid path' }, 400);
      }
      targetDir = resolved;

      // Ensure it's a directory
      try {
        const stat = await fs.stat(targetDir);
        if (!stat.isDirectory()) {
          return c.json({ ok: false, error: 'Not a directory' }, 400);
        }
      } catch {
        return c.json({ ok: false, error: 'Directory not found' }, 404);
      }
    } else {
      targetDir = root;
    }
    rootPath = subPath || '.';
  }

  const entries = await listDirectory(targetDir, rootPath, depth, scope);

  const workspaceRoot = getWorkspaceRoot();
  return c.json({ ok: true, scope, root: rootPath, workspaceRoot, entries });
});

// ── GET /api/files/read ──────────────────────────────────────────────

app.get('/api/files/read', async (c) => {
  const scope = parseScope(c.req.query('scope'));
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }
  const filePath = c.req.query('path');
  if (!filePath) {
    return c.json({ ok: false, error: 'Missing path parameter' }, 400);
  }

  let resolved: string | null;
  if (scope === 'fs') {
    if (!path.isAbsolute(filePath)) {
      return c.json({ ok: false, error: 'Path must be absolute for filesystem scope' }, 400);
    }
    resolved = await resolveFsPath(filePath);
  } else {
    resolved = await resolveWorkspacePath(filePath);
  }
  
  if (!resolved) {
    return c.json({ ok: false, error: 'Invalid or excluded path' }, 403);
  }

  // Check if binary
  if (isBinary(path.basename(resolved))) {
    return c.json({ ok: false, error: 'Binary file', binary: true }, 415);
  }

  // Stat the file
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return c.json({ ok: false, error: 'File not found' }, 404);
  }

  if (!stat.isFile()) {
    return c.json({ ok: false, error: 'Not a file' }, 400);
  }

  if (stat.size > MAX_FILE_SIZE) {
    return c.json({ ok: false, error: `File too large (${(stat.size / 1024).toFixed(0)}KB, max 1MB)` }, 413);
  }

  try {
    const content = await fs.readFile(resolved, 'utf-8');
    return c.json({
      ok: true,
      content,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
    });
  } catch {
    return c.json({ ok: false, error: 'Failed to read file' }, 500);
  }
});

// ── PUT /api/files/write ─────────────────────────────────────────────

app.put('/api/files/write', async (c) => {
  let body: { path?: string; content?: string; expectedMtime?: number; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { path: filePath, content, expectedMtime, scope: bodyScope } = body;
  const scope = parseScope(bodyScope);
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }

  if (!filePath || typeof filePath !== 'string') {
    return c.json({ ok: false, error: 'Missing path' }, 400);
  }
  if (typeof content !== 'string') {
    return c.json({ ok: false, error: 'Missing or invalid content' }, 400);
  }
  if (content.length > MAX_FILE_SIZE) {
    return c.json({ ok: false, error: 'Content too large (max 1MB)' }, 413);
  }

  let resolved: string | null;
  if (scope === 'fs') {
    if (!path.isAbsolute(filePath)) {
      return c.json({ ok: false, error: 'Path must be absolute for filesystem scope' }, 400);
    }
    resolved = await resolveFsPath(filePath, { allowNonExistent: true });
  } else {
    resolved = await resolveWorkspacePath(filePath, { allowNonExistent: true });
  }
  
  if (!resolved) {
    return c.json({ ok: false, error: 'Invalid or excluded path' }, 403);
  }

  if (isBinary(path.basename(resolved))) {
    return c.json({ ok: false, error: 'Cannot write binary files' }, 415);
  }

  // Conflict detection: check mtime if expectedMtime provided
  if (typeof expectedMtime === 'number') {
    try {
      const stat = await fs.stat(resolved);
      const currentMtime = Math.floor(stat.mtimeMs);
      if (currentMtime !== expectedMtime) {
        return c.json({
          ok: false,
          error: 'File was modified since you loaded it',
          currentMtime,
        }, 409);
      }
    } catch {
      // File doesn't exist yet — no conflict possible
    }
  }

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  // Write the file
  try {
    await fs.writeFile(resolved, content, 'utf-8');
    const stat = await fs.stat(resolved);
    return c.json({
      ok: true,
      mtime: Math.floor(stat.mtimeMs),
    });
  } catch {
    return c.json({ ok: false, error: 'Failed to write file' }, 500);
  }
});

// ── POST /api/files/rename ────────────────────────────────────────────

app.post('/api/files/rename', async (c) => {
  let body: { path?: string; newName?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.path || typeof body.path !== 'string') {
    return c.json({ ok: false, error: 'Missing path' }, 400);
  }
  if (!body.newName || typeof body.newName !== 'string') {
    return c.json({ ok: false, error: 'Missing newName' }, 400);
  }

  const scope = parseScope(body.scope);
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }

  try {
    const result = await renameEntry({ path: body.path, newName: body.newName, scope });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return handleFileOpError(c, err);
  }
});

// ── POST /api/files/move ──────────────────────────────────────────────

app.post('/api/files/move', async (c) => {
  let body: { sourcePath?: string; targetDirPath?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.sourcePath || typeof body.sourcePath !== 'string') {
    return c.json({ ok: false, error: 'Missing sourcePath' }, 400);
  }
  if (typeof body.targetDirPath !== 'string') {
    return c.json({ ok: false, error: 'Missing targetDirPath' }, 400);
  }

  const scope = parseScope(body.scope);
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }

  try {
    const result = await moveEntry({
      sourcePath: body.sourcePath,
      targetDirPath: body.targetDirPath,
      scope,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return handleFileOpError(c, err);
  }
});

// ── POST /api/files/trash ─────────────────────────────────────────────

app.post('/api/files/trash', async (c) => {
  let body: { path?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.path || typeof body.path !== 'string') {
    return c.json({ ok: false, error: 'Missing path' }, 400);
  }

  const scope = parseScope(body.scope);
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }

  if (scope === 'fs') {
    return c.json({ ok: false, error: 'Trash not supported in filesystem scope. Use /api/files/delete for permanent deletion.' }, 400);
  }

  try {
    const result = await trashEntry({ path: body.path });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return handleFileOpError(c, err);
  }
});

// ── POST /api/files/delete ────────────────────────────────────────────

app.post('/api/files/delete', async (c) => {
  let body: { path?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.path || typeof body.path !== 'string') {
    return c.json({ ok: false, error: 'Missing path' }, 400);
  }

  const scope = parseScope(body.scope);
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }

  if (scope !== 'fs') {
    return c.json({ ok: false, error: 'Delete endpoint only supports filesystem scope. Use /api/files/trash for workspace items.' }, 400);
  }

  try {
    const result = await deleteEntryPermanently({ path: body.path });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return handleFileOpError(c, err);
  }
});

// ── POST /api/files/restore ───────────────────────────────────────────

app.post('/api/files/restore', async (c) => {
  let body: { path?: string; scope?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.path || typeof body.path !== 'string') {
    return c.json({ ok: false, error: 'Missing path' }, 400);
  }

  const scope = parseScope(body.scope);
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }

  // Restore is workspace-only (trash system requires workspace-relative paths)
  if (scope === 'fs') {
    return c.json({ ok: false, error: 'Restore not supported in filesystem scope. Only workspace items can be restored from trash.' }, 400);
  }

  try {
    const result = await restoreEntry({ path: body.path });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return handleFileOpError(c, err);
  }
});

// ── GET /api/files/raw ───────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico']);

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Check if a file is a supported image. */
export function isImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

app.get('/api/files/raw', async (c) => {
  const scope = parseScope(c.req.query('scope'));
  if (!scope) {
    return c.json({ ok: false, error: 'Invalid scope parameter' }, 400);
  }
  const filePath = c.req.query('path');
  if (!filePath) {
    return c.json({ ok: false, error: 'Missing path parameter' }, 400);
  }

  let resolved: string | null;
  if (scope === 'fs') {
    if (!path.isAbsolute(filePath)) {
      return c.json({ ok: false, error: 'Path must be absolute for filesystem scope' }, 400);
    }
    resolved = await resolveFsPath(filePath);
  } else {
    resolved = await resolveWorkspacePath(filePath);
  }
  
  if (!resolved) {
    return c.json({ ok: false, error: 'Invalid or excluded path' }, 403);
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) {
    return c.json({ ok: false, error: 'Unsupported file type' }, 415);
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return c.json({ ok: false, error: 'Not a file' }, 400);
    }
    // Cap at 10MB for images
    if (stat.size > 10_485_760) {
      return c.json({ ok: false, error: 'File too large (max 10MB)' }, 413);
    }

    const buffer = await fs.readFile(resolved);
    return new Response(buffer, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return c.json({ ok: false, error: 'Failed to read file' }, 500);
  }
});

export default app;
