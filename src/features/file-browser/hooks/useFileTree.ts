import { useState, useCallback, useEffect, useRef } from 'react';
import type { TreeEntry } from '../types';

const STORAGE_KEY = 'nerve-file-tree-expanded';
const ROOT_PATH_STORAGE_KEY = 'nerve-file-tree-root-path';

function loadExpandedPaths(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* ignore */ }
  return new Set<string>();
}

function saveExpandedPaths(paths: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...paths]));
  } catch { /* ignore */ }
}

function loadRootPath(): string {
  try {
    return localStorage.getItem(ROOT_PATH_STORAGE_KEY) || '';
  } catch { return ''; }
}

function saveRootPath(rootPath: string) {
  try {
    localStorage.setItem(ROOT_PATH_STORAGE_KEY, rootPath);
  } catch { /* ignore */ }
}

function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  // Unix absolute path
  if (p.startsWith('/')) return true;
  // Windows absolute path (e.g., C:\... or C:/...)
  if (/^[A-Za-z]:[/\\]/.test(p)) return true;
  // UNC path (e.g., \\server\share or //server/share)
  if (/^[/\\]{2}[^/\\]+[/\\]/.test(p)) return true;
  return false;
}

function parentPath(dirPath: string): string {
  if (!dirPath) return dirPath;
  const normalized = dirPath.replace(/\\/g, '/');

  // Windows drive root (e.g., C:/)
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized;

  // Unix filesystem root
  if (normalized === '/') return '/';

  // UNC path: compute the UNC root (//server/share)
  let uncRoot: string | null = null;
  if (normalized.startsWith('//')) {
    const parts = normalized.slice(2).split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      uncRoot = '//' + parts[0] + '/' + parts[1];
      // If we're already at the UNC root, don't ascend
      if (normalized === uncRoot || normalized === uncRoot + '/') {
        return uncRoot;
      }
    }
  }

  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const lastSlash = trimmed.lastIndexOf('/');

  // No slash found: workspace-relative path (e.g., "src") -> return empty string (workspace root)
  if (lastSlash === -1) return '';

  // Only leading slash: Unix root
  if (lastSlash === 0) return '/';

  const parent = trimmed.slice(0, lastSlash);

  // Check if parent is a Windows drive letter (e.g., "C:" from "C:/foo")
  if (/^[A-Za-z]:$/.test(parent)) return parent + '/';

  // If we have a UNC root and the parent would be shorter than it, return the UNC root
  if (uncRoot && parent.length < uncRoot.length) {
    return uncRoot;
  }

  return parent;
}

/** Merge freshly loaded children into the tree (immutable update). */
function mergeChildren(
  entries: TreeEntry[],
  parentPath: string,
  children: TreeEntry[],
): TreeEntry[] {
  return entries.map((entry) => {
    if (entry.path === parentPath && entry.type === 'directory') {
      return { ...entry, children };
    }
    if (entry.children && entry.type === 'directory') {
      return { ...entry, children: mergeChildren(entry.children, parentPath, children) };
    }
    return entry;
  });
}

export function useFileTree() {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(loadExpandedPaths);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [rootPath, setRootPath] = useState<string>(loadRootPath);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Persist expanded paths and root path
  useEffect(() => {
    saveExpandedPaths(expandedPaths);
  }, [expandedPaths]);

  useEffect(() => {
    saveRootPath(rootPath);
  }, [rootPath]);

  // Determine scope based on path
  const getScope = useCallback((path: string): 'workspace' | 'fs' => {
    return isAbsolutePath(path) ? 'fs' : 'workspace';
  }, []);

  const fetchTree = useCallback(async (dirPath: string): Promise<{ entries: TreeEntry[]; workspaceRoot?: string } | null> => {
    try {
      const scope = getScope(dirPath || rootPath);
      const pathParam = dirPath || rootPath;

      let params: string;
      if (scope === 'fs') {
        params = `?scope=fs&path=${encodeURIComponent(pathParam)}&depth=1`;
      } else {
        params = pathParam ? `?path=${encodeURIComponent(pathParam)}&depth=1` : '?depth=1';
      }

      const res = await fetch(`/api/files/tree${params}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.ok) return null;
      return { entries: data.entries, workspaceRoot: typeof data.workspaceRoot === 'string' ? data.workspaceRoot : undefined };
    } catch {
      return null;
    }
  }, [rootPath, getScope]);

  // Fetch a directory's children (entries only)
  const fetchChildren = useCallback(async (dirPath: string): Promise<TreeEntry[] | null> => {
    const res = await fetchTree(dirPath);
    if (!res) return null;
    if (res.workspaceRoot) setWorkspaceRoot(res.workspaceRoot);
    return res.entries;
  }, [fetchTree]);

  // Initial load
  const loadRoot = useCallback(async () => {
    requestIdRef.current += 1;
    const currentRequestId = requestIdRef.current;

    setLoading(true);
    setError(null);
    const children = await fetchChildren('');
    if (!mountedRef.current || requestIdRef.current !== currentRequestId) return;

    if (children) {
      setEntries(children);

      // Re-expand previously expanded directories
      const expanded = loadExpandedPaths();
      if (expanded.size > 0) {
        // Fetch children for each expanded path (in parallel)
        const promises = [...expanded].map(async (p) => {
          const ch = await fetchChildren(p);
          return ch ? { path: p, children: ch } : null;
        });
        const results = await Promise.all(promises);
        if (!mountedRef.current || requestIdRef.current !== currentRequestId) return;

        let tree = children;
        for (const r of results) {
          if (r) tree = mergeChildren(tree, r.path, r.children);
        }
        setEntries(tree);
      }
    } else {
      setError('Failed to load file tree');
    }
    if (requestIdRef.current === currentRequestId) {
       setLoading(false);
    }
  }, [fetchChildren]);

  const toggleDirectory = useCallback(async (dirPath: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
        return next;
      }
      next.add(dirPath);
      return next;
    });

    // If collapsing or children already loaded, just toggle
    if (expandedPaths.has(dirPath)) return;

    // Check if children are already loaded in the tree
    const findEntry = (es: TreeEntry[], target: string): TreeEntry | null => {
      for (const e of es) {
        if (e.path === target) return e;
        if (e.children) {
          const found = findEntry(e.children, target);
          if (found) return found;
        }
      }
      return null;
    };
    const entry = findEntry(entries, dirPath);
    if (entry?.children !== null && entry?.children !== undefined) return;

    // Fetch children
    setLoadingPaths((prev) => new Set([...prev, dirPath]));
    const children = await fetchChildren(dirPath);
    if (!mountedRef.current) return;
    setLoadingPaths((prev) => {
      const next = new Set(prev);
      next.delete(dirPath);
      return next;
    });

    if (children) {
      setEntries((prev) => mergeChildren(prev, dirPath, children));
    }
  }, [expandedPaths, entries, fetchChildren]);

  const selectFile = useCallback((filePath: string) => {
    setSelectedPath(filePath);
  }, []);

  const refresh = useCallback(() => {
    // Clear cached children so everything re-fetches
    setEntries([]);
    loadRoot();
  }, [loadRoot]);

  /** Refresh a specific directory (or root) when a file changes externally. */
  const refreshDirectory = useCallback(async (dirPath: string) => {
    const children = await fetchChildren(dirPath);
    if (!mountedRef.current || !children) return;

    if (!dirPath) {
      // Root — just replace top-level entries (preserve expanded subdirs)
      setEntries((prev) => {
        // Keep expanded children from prev, merge with fresh top-level
        return children.map(fresh => {
          const existing = prev.find(e => e.path === fresh.path);
          if (existing?.children && fresh.type === 'directory') {
            return { ...fresh, children: existing.children };
          }
          return fresh;
        });
      });
    } else {
      setEntries((prev) => mergeChildren(prev, dirPath, children));
    }
  }, [fetchChildren]);

  /**
   * Handle an external file change event.
   * Refreshes the parent directory of the changed file so the tree
   * picks up new/deleted files.
   */
  const handleFileChange = useCallback((changedPath: string) => {
    const parentDir = changedPath.includes('/')
      ? changedPath.substring(0, changedPath.lastIndexOf('/'))
      : '';
    // Only refresh if the parent is expanded (or is root)
    if (!parentDir || expandedPaths.has(parentDir)) {
      refreshDirectory(parentDir);
    }
  }, [expandedPaths, refreshDirectory]);

  const navigateToRoot = useCallback((newRootPath: string) => {
    setRootPath(newRootPath);
    setEntries([]);
    setExpandedPaths(new Set());
    setLoading(true);
    setError(null);
  }, []);

  const navigateUp = useCallback(() => {
    // Workspace scope: compute absolute current root so we can move outside workspace.
    if (!isAbsolutePath(rootPath)) {
      if (!workspaceRoot) return;

      const absCurrent = rootPath
        ? `${workspaceRoot.replace(/\/+$/g, '')}/${rootPath.replace(/^\/+/, '')}`
        : workspaceRoot;
      const absParent = parentPath(absCurrent);
      if (absParent !== absCurrent) {
        navigateToRoot(absParent);
      }
      return;
    }

    // Filesystem scope
    const parent = parentPath(rootPath);
    if (parent !== rootPath) {
      navigateToRoot(parent);
    }
  }, [rootPath, workspaceRoot, navigateToRoot]);

  const navigateHome = useCallback(() => {
    navigateToRoot('');
  }, [navigateToRoot]);

  // When rootPath changes (navigation), reload the root listing.
  // Also handles initial mount since rootPath has an initial value.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reload tree when navigation changes rootPath
    void loadRoot();
  }, [rootPath, loadRoot]);

  return {
    entries,
    loading,
    error,
    expandedPaths,
    selectedPath,
    loadingPaths,
    rootPath,
    scope: getScope(rootPath),
    workspaceRoot,
    toggleDirectory,
    selectFile,
    refresh,
    handleFileChange,
    navigateToRoot,
    navigateUp,
    navigateHome,
  };
}
