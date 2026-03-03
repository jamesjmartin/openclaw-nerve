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

/** Resolve the default workspace root directory (parent of MEMORY.md). */
export function getWorkspaceRoot(): string {
  return path.dirname(config.memoryPath);
}

/** Get all workspace roots as an array. Custom paths come first, default root is always included. */
export function getWorkspaceRoots(): string[] {
  if (config.fileBrowserPaths) {
    const paths = config.fileBrowserPaths.split(',').map(p => p.trim()).filter(p => p.length > 0);
    if (paths.length > 0) return paths;
  }
  return [getWorkspaceRoot()];
}

/** Check if custom workspace paths are configured via NERVE_WORKSPACE_PATHS. */
export function isCustomWorkspace(): boolean {
  if (!config.fileBrowserPaths) return false;
  return config.fileBrowserPaths.split(',').some(p => p.trim().length > 0);
}

/**
 * Find the workspace root that contains the given absolute path.
 * Returns the matching root or null if the path is not within any workspace.
 */
export function findWorkspaceRootForPath(absPath: string): string | null {
  const roots = getWorkspaceRoots();
  for (const root of roots) {
    if (absPath === root || absPath.startsWith(root + path.sep)) {
      return root;
    }
  }
  return null;
}

// ── Path validation ──────────────────────────────────────────────────

/** Max file size for reading/writing (1 MB). */
export const MAX_FILE_SIZE = 1_048_576;

/**
 * Validate and resolve a path to an absolute path within an allowed workspace.
 *
 * Accepts both relative paths (resolved against the default workspace root)
 * and absolute paths (validated against all configured workspace roots).
 *
 * Returns the resolved absolute path, or `null` if:
 * - The path escapes all workspace roots (traversal)
 * - The path resolves through a symlink to outside the workspace
 * - The path is excluded
 *
 * For write operations where the file may not exist yet, the parent
 * directory is validated instead.
 */
export async function resolveWorkspacePath(
  inputPath: string,
  options?: { allowNonExistent?: boolean },
): Promise<string | null> {
  // Absolute path: validate against all allowed workspace roots
  if (path.isAbsolute(inputPath)) {
    return resolveAbsoluteWorkspacePath(inputPath, options);
  }

  // Relative path: resolve against default workspace root (backward compat)
  return resolveRelativeWorkspacePath(inputPath, getWorkspaceRoot(), options);
}

/** Validate an absolute path is within one of the allowed workspace roots. */
async function resolveAbsoluteWorkspacePath(
  absPath: string,
  options?: { allowNonExistent?: boolean },
): Promise<string | null> {
  const normalized = path.normalize(absPath);
  const root = findWorkspaceRootForPath(normalized);
  if (!root) return null;

  // Check exclusions on the relative portion
  const relativePart = path.relative(root, normalized);
  if (relativePart) {
    const segments = relativePart.split(path.sep);
    if (segments.some(seg => seg && isExcluded(seg))) return null;
  }

  return validateResolvedPath(normalized, root, options);
}

/** Resolve a relative path against a specific workspace root. */
async function resolveRelativeWorkspacePath(
  relativePath: string,
  root: string,
  options?: { allowNonExistent?: boolean },
): Promise<string | null> {
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;

  const segments = normalized.split(path.sep);
  if (segments.some(seg => seg && isExcluded(seg))) return null;

  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;

  return validateResolvedPath(resolved, root, options);
}

/** Common symlink validation for resolved absolute paths. */
async function validateResolvedPath(
  resolved: string,
  root: string,
  options?: { allowNonExistent?: boolean },
): Promise<string | null> {
  try {
    const real = await fs.realpath(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) return null;
    return real;
  } catch {
    if (!options?.allowNonExistent) return null;

    const parent = path.dirname(resolved);
    try {
      const realParent = await fs.realpath(parent);
      if (!realParent.startsWith(root + path.sep) && realParent !== root) return null;
      return resolved;
    } catch {
      return null;
    }
  }
}
