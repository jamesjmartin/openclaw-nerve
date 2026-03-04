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
// When FILE_BROWSER_ROOT is set, disable all exclusions to show complete directory structure
// When using default workspace, apply standard exclusions for safety and cleanliness

const DEFAULT_EXCLUDED_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'server-dist', 'certs',
  '.env', 'agent-log.json',
]);

const DEFAULT_EXCLUDED_PATTERNS = [
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

/** Get exclusion names based on current config state */
function getExcludedNames(): Set<string> {
  return config.fileBrowserRoot && config.fileBrowserRoot.trim() !== '' ? new Set([]) : DEFAULT_EXCLUDED_NAMES;
}

/** Get exclusion patterns based on current config state */
function getExcludedPatterns(): RegExp[] {
  return config.fileBrowserRoot && config.fileBrowserRoot.trim() !== '' ? [] : DEFAULT_EXCLUDED_PATTERNS;
}

/** Check if a file/directory name should be excluded from the tree. */
export function isExcluded(name: string): boolean {
  const excludedNames = getExcludedNames();
  const excludedPatterns = getExcludedPatterns();

  if (excludedNames.has(name)) return true;
  return excludedPatterns.some(p => p.test(name));
}

/** Check if a file extension indicates binary content. */
export function isBinary(name: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

// ── Workspace root ───────────────────────────────────────────────────

/** Resolve the workspace root directory. Uses FILE_BROWSER_ROOT if set and valid, otherwise parent of MEMORY.md. */
export function getWorkspaceRoot(): string {
  const customRoot = config.fileBrowserRoot.trim();
  return customRoot ? path.resolve(customRoot) : path.dirname(config.memoryPath);
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
