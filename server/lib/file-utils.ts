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

/** Normalize a path to use forward slashes for UI consumption. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

// ── Workspace root ───────────────────────────────────────────────────

/** Resolve the workspace root directory (parent of MEMORY.md). */
export function getWorkspaceRoot(): string {
  return path.dirname(config.memoryPath);
}

// ── Path validation ──────────────────────────────────────────────────

/** Max file size for reading/writing (1 MB). */
export const MAX_FILE_SIZE = 1_048_576;

/**
 * Validate and resolve a relative path to an absolute path within the workspace.
 *
 * Returns the resolved absolute path, or `null` if:
 * - The path escapes the workspace root (traversal)
 * - The path resolves through a symlink to outside the workspace
 * - The path is excluded
 *
 * For write operations where the file may not exist yet, the parent
 * directory is validated instead.
 */
export async function resolveWorkspacePath(
  relativePath: string,
  options?: { allowNonExistent?: boolean },
): Promise<string | null> {
  const root = getWorkspaceRoot();

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

/**
 * Calculate the parent directory of a given path.
 * Handles filesystem root and Windows drive roots correctly.
 */
export function parentPath(dirPath: string): string {
  if (!dirPath) return dirPath;
  const normalized = dirPath.replace(/\\/g, '/');
  
  // Windows drive root (e.g., C:/)
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized;
  
  // Unix filesystem root
  if (normalized === '/') return '/';
  
  // Collapse multiple trailing slashes before trimming
  const collapsedTrailing = normalized.replace(/\/+$/, '/');
  const trimmed = collapsedTrailing.endsWith('/') ? collapsedTrailing.slice(0, -1) : collapsedTrailing;
  const lastSlash = trimmed.lastIndexOf('/');
  
  // If no slash or only leading slash, return root
  if (lastSlash <= 0) return '/';
  
  const parent = trimmed.slice(0, lastSlash);
  
  // Check if parent is a Windows drive letter (e.g., "C:" from "C:/Users")
  if (/^[A-Za-z]:$/.test(parent)) return parent + '/';
  
  return parent;
}

/**
 * Validate and resolve an absolute path for filesystem scope.
 * 
 * Returns the resolved absolute path, or `null` if:
 * - The path is not absolute
 * - The path contains excluded segments
 * - The path resolves through a symlink to an excluded location
 * 
 * For write operations where the file may not exist yet, the parent
 * directory is validated instead.
 */
export async function resolveFsPath(
  absolutePath: string,
  options?: { allowNonExistent?: boolean },
): Promise<string | null> {
  // Must be absolute
  if (!path.isAbsolute(absolutePath)) {
    return null;
  }

  const normalized = path.normalize(absolutePath);

  // Check each path segment for exclusions
  const segments = normalized.split(path.sep).filter(Boolean);
  if (segments.some(seg => isExcluded(seg))) {
    return null;
  }

  // Resolve symlinks for validation only
  try {
    const real = await fs.realpath(normalized);
    
    // Re-check exclusions on resolved path
    const realSegments = real.split(path.sep).filter(Boolean);
    if (realSegments.some(seg => isExcluded(seg))) {
      return null;
    }
    
    // Return original path to preserve symlink semantics
    return normalized;
  } catch {
    // File doesn't exist
    if (!options?.allowNonExistent) return null;

    // For new files, validate the parent directory
    const parent = path.dirname(normalized);
    try {
      const realParent = await fs.realpath(parent);
      
      // Check parent for exclusions
      const parentSegments = realParent.split(path.sep).filter(Boolean);
      if (parentSegments.some(seg => isExcluded(seg))) {
        return null;
      }
      
      return normalized;
    } catch {
      return null;
    }
  }
}
