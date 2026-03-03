/**
 * Shared file utilities for the file browser.
 *
 * Path validation, exclusion lists, binary detection, and workspace
 * path resolution. Used by both the file-browser API routes and
 * the extended file watcher.
 * @module
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from './config.js';

// ── Exclusion rules ──────────────────────────────────────────────────

const EXCLUDED_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'server-dist', 'certs',
  '.env', 'agent-log.json',
]);

const EXCLUDED_PATTERNS = [
  /^\.env(\.|$)/,   // .env, .env.local, .env.production, etc.
  /\.log$/,
];

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.webm',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot',
  '.sqlite', '.db',
]);

/** Check if a file/directory name should be excluded from the tree. */
export function isExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  return EXCLUDED_PATTERNS.some(p => p.test(name));
}

/** Check if a file extension indicates binary content. */
export function isBinary(name: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

// ── Workspace root ───────────────────────────────────────────────────

/** Get all workspace roots as an array */
export function getWorkspaceRoots(): string[] {
  if (config.fileBrowserPaths) {
    const paths = config.fileBrowserPaths.split(',').map(p => p.trim()).filter(p => p.length > 0);
    if (paths.length > 0) {
      return paths;
    }
  }
  
  // Default to single workspace
  return [path.dirname(config.memoryPath)];
}

/** Resolve the workspace root directory for a specific workspace index */
export function getWorkspaceRoot(workspaceIndex = 0): string {
  const roots = getWorkspaceRoots();
  if (workspaceIndex < 0 || workspaceIndex >= roots.length) {
    throw new RangeError(
      `Workspace index ${workspaceIndex} is out of bounds (0-${roots.length - 1})`
    );
  }
  return roots[workspaceIndex];
}

/** Check if the current workspace is using a custom path from NERVE_WORKSPACE_PATHS */
export function isCustomWorkspace(): boolean {
  if (config.fileBrowserPaths) {
    const paths = config.fileBrowserPaths.split(',').map(p => p.trim()).filter(p => p.length > 0);
    return paths.length > 0;
  }
  return false;
}

// ── Path validation ──────────────────────────────────────────────────

/** Max file size for reading/writing (1 MB). */
export const MAX_FILE_SIZE = 1_048_576;

/**
 * Validate and resolve a relative path to an absolute path within the workspace.
 *
 * Returns the resolved absolute path, or `null` if:
 * - The path escapes the workspace root (traversal)
 * - The path contains excluded segments (e.g., `node_modules`)
 * - The file doesn't exist (unless `allowNonExistent` is true)
 *
 * For write operations where the file may not exist yet, the parent
 * directory is validated instead.
 */
export async function resolveWorkspacePath(
  relativePath: string,
  options?: { allowNonExistent?: boolean; workspaceIndex?: number },
): Promise<string | null> {
  const root = getWorkspaceRoot(options?.workspaceIndex);

  // Block obvious traversal attempts
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return null;
  }

  // Check each path segment for exclusions
  const segments = normalized.split(path.sep);
  if (segments.some(seg => seg && isExcluded(seg))) {
    return null;
  }

  const resolved = path.resolve(root, normalized);

  // Must be within workspace root
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return null;
  }

  // Resolve symlinks and re-check
  try {
    const real = await fs.realpath(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) {
      return null;
    }
    return real;
  } catch {
    // File doesn't exist
    if (!options?.allowNonExistent) return null;

    // For new files, validate the parent directory
    const parent = path.dirname(resolved);
    try {
      const realParent = await fs.realpath(parent);
      if (!realParent.startsWith(root + path.sep) && realParent !== root) {
        return null;
      }
      return resolved;
    } catch {
      return null;
    }
  }
}
