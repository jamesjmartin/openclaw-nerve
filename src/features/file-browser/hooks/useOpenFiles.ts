import { useState, useCallback, useRef, useEffect } from 'react';
import { isImageFile } from '../utils/fileTypes';
import type { OpenFile } from '../types';

const STORAGE_KEY_FILES = 'nerve-open-files';
const STORAGE_KEY_TAB = 'nerve-active-tab';
const MAX_OPEN_TABS = 20;

function loadPersistedFiles(): Array<{ workspaceIndex: number; path: string }> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_FILES);
    if (!stored) return [];
    const keys = JSON.parse(stored) as string[];
    return keys.map(key => {
      const colonIndex = key.indexOf(':');
      // Old format: plain path without workspace prefix — treat as workspace 0
      if (colonIndex === -1) return { workspaceIndex: 0, path: key };
      const wsIndex = Number.parseInt(key.slice(0, colonIndex), 10);
      if (Number.isNaN(wsIndex)) return { workspaceIndex: 0, path: key };
      return { workspaceIndex: wsIndex, path: key.slice(colonIndex + 1) };
    });
  } catch { return []; }
}

function loadPersistedTab(): string {
  try {
    return localStorage.getItem(STORAGE_KEY_TAB) || 'chat';
  } catch { return 'chat'; }
}

function persistFiles(files: OpenFile[]) {
  try {
    localStorage.setItem(STORAGE_KEY_FILES, JSON.stringify(files.map(f => makeFileKey(f.workspaceIndex, f.path))));
  } catch { /* ignore */ }
}

function persistTab(tab: string) {
  try {
    localStorage.setItem(STORAGE_KEY_TAB, tab);
  } catch { /* ignore */ }
}

function basename(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function matchesPathPrefix(candidatePath: string, prefix: string): boolean {
  return candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
}

function remapPathPrefix(candidatePath: string, fromPrefix: string, toPrefix: string): string {
  if (candidatePath === fromPrefix) return toPrefix;
  if (!candidatePath.startsWith(`${fromPrefix}/`)) return candidatePath;
  return `${toPrefix}${candidatePath.slice(fromPrefix.length)}`;
}

export function makeFileKey(workspaceIndex: number, path: string): string {
  return `${workspaceIndex}:${path}`;
}

export function parseFileKey(fileKey: string): { workspaceIndex: number; path: string } {
  const colonIndex = fileKey.indexOf(':');
  if (colonIndex === -1) return { workspaceIndex: 0, path: fileKey };
  const wsIndex = Number.parseInt(fileKey.slice(0, colonIndex), 10);
  if (Number.isNaN(wsIndex)) return { workspaceIndex: 0, path: fileKey };
  return { workspaceIndex: wsIndex, path: fileKey.slice(colonIndex + 1) };
}

export function useOpenFiles(workspaceIndex = 0) {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeTab, setActiveTabState] = useState<string>(loadPersistedTab);
  const initializedRef = useRef(false);

  // Track mtimes from our own saves so we can ignore the SSE bounce-back
  const recentSaveMtimes = useRef<Map<string, number>>(new Map());
  /** Paths currently being saved — blocks lock overlay during the save round-trip */
  const savingPaths = useRef<Set<string>>(new Set());

  // Restore previously open files on first render
  const initializeFiles = useCallback(async () => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const fileEntries = loadPersistedFiles();
    if (fileEntries.length === 0) return;

    // Only load files for the current workspace
    const workspaceFiles = fileEntries.filter(entry => entry.workspaceIndex === workspaceIndex);
    if (workspaceFiles.length === 0) return;

    const files: OpenFile[] = [];
    for (const entry of workspaceFiles) {
      try {
        const res = await fetch(`/api/files/read?workspaceIndex=${entry.workspaceIndex}&path=${encodeURIComponent(entry.path)}`);
        if (!res.ok) continue;
        const data = await res.json();
        if (!data.ok) continue;
        files.push({
          path: entry.path,
          name: basename(entry.path),
          content: data.content,
          savedContent: data.content,
          dirty: false,
          locked: false,
          mtime: data.mtime,
          loading: false,
          workspaceIndex: entry.workspaceIndex,
        });
      } catch {
        // Skip files that can't be loaded
      }
    }

    if (files.length > 0) {
      setOpenFiles(files);
    }
  }, [workspaceIndex]);

  const setActiveTab = useCallback((tab: string) => {
    setActiveTabState(tab);
    persistTab(tab);
  }, []);

  const openFile = useCallback(async (filePath: string) => {
    // If already open, just switch tab
    const fileKey = makeFileKey(workspaceIndex, filePath);
    setOpenFiles((prev) => {
      const existing = prev.find(f => f.workspaceIndex === workspaceIndex && f.path === filePath);
      if (existing) return prev;

      // Enforce tab limit — close oldest non-dirty tab to make room
      let base = prev;
      if (base.length >= MAX_OPEN_TABS) {
        const oldest = base.find(f => !f.dirty);
        if (oldest) {
          base = base.filter(f => !(f.workspaceIndex === oldest.workspaceIndex && f.path === oldest.path));
        } else {
          // All dirty — close oldest anyway
          base = base.slice(1);
        }
      }

      // Add placeholder while loading
      const newFile: OpenFile = {
        path: filePath,
        name: basename(filePath),
        content: '',
        savedContent: '',
        dirty: false,
        locked: false,
        mtime: 0,
        loading: true,
        workspaceIndex,
      };
      const next = [...base, newFile];
      persistFiles(next);
      return next;
    });

    setActiveTab(fileKey);

    // Images don't need content — just mark as loaded
    if (isImageFile(basename(filePath))) {
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.workspaceIndex === workspaceIndex && f.path === filePath ? { ...f, loading: false } : f,
        ),
      );
      return;
    }

    // Fetch content for text files
    try {
      const res = await fetch(`/api/files/read?workspaceIndex=${workspaceIndex}&path=${encodeURIComponent(filePath)}`);
      const data = await res.json();

      setOpenFiles((prev) =>
        prev.map((f) => {
          if (f.workspaceIndex !== workspaceIndex || f.path !== filePath) return f;
          if (!data.ok) {
            return { ...f, loading: false, error: data.error || 'Failed to load' };
          }
          return {
            ...f,
            content: data.content,
            savedContent: data.content,
            mtime: data.mtime,
            loading: false,
            error: undefined,
          };
        }),
      );
    } catch {
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.workspaceIndex === workspaceIndex && f.path === filePath
            ? { ...f, loading: false, error: 'Network error' }
            : f,
        ),
      );
    }
  }, [setActiveTab, workspaceIndex]);

  const closeFile = useCallback((fileKeyOrPath: string) => {
    // Parse the input - could be composite key "0:file.ts" or raw path "file.ts"
    const { workspaceIndex: targetWs, path: targetPath } = parseFileKey(fileKeyOrPath);
    const fileKey = makeFileKey(targetWs, targetPath);
    
    setOpenFiles((prev) => {
      const next = prev.filter(f => !(f.workspaceIndex === targetWs && f.path === targetPath));
      persistFiles(next);
      return next;
    });

    // If closing the active tab, switch to chat or previous tab
    setActiveTabState((currentTab) => {
      if (currentTab !== fileKey) return currentTab;
      const tab = 'chat';
      persistTab(tab);
      return tab;
    });
  }, []);

  const updateContent = useCallback((filePath: string, content: string) => {
    setOpenFiles((prev) =>
      prev.map((f) => {
        if (f.workspaceIndex !== workspaceIndex || f.path !== filePath) return f;
        return { ...f, content, dirty: content !== f.savedContent };
      }),
    );
  }, [workspaceIndex]);

  // Ref to always have current openFiles for saveFile (avoids stale closure)
  const openFilesRef = useRef(openFiles);
  useEffect(() => { openFilesRef.current = openFiles; });

  const saveFile = useCallback(async (filePath: string): Promise<{ ok: boolean; conflict?: boolean }> => {
    const file = openFilesRef.current.find(f => f.workspaceIndex === workspaceIndex && f.path === filePath);
    if (!file) return { ok: false };

    // Use workspace-scoped key for dedup/lock bookkeeping
    const fileKey = makeFileKey(workspaceIndex, filePath);

    try {
      // Mark as saving BEFORE the request — prevents the SSE bounce-back
      // from triggering the lock overlay while we wait for the response
      savingPaths.current.add(fileKey);

      const res = await fetch('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: filePath,
          content: file.content,
          mtime: file.mtime,
          workspaceIndex,
        }),
      });
      const data = await res.json();

      if (data.ok) {
        // Track this mtime so we ignore the SSE bounce-back from our own save
        recentSaveMtimes.current.set(fileKey, data.mtime);
        setTimeout(() => recentSaveMtimes.current.delete(fileKey), 2000);

        setOpenFiles((prev) =>
          prev.map((f) =>
            f.workspaceIndex === workspaceIndex && f.path === filePath
              ? { ...f, savedContent: f.content, dirty: false, mtime: data.mtime }
              : f,
          ),
        );
        savingPaths.current.delete(fileKey);
        return { ok: true };
      }

      // 409 Conflict — file was modified externally
      if (res.status === 409) {
        return { ok: false, conflict: true };
      }

      savingPaths.current.delete(fileKey);
      return { ok: false };
    } catch {
      savingPaths.current.delete(fileKey);
      return { ok: false };
    }
  }, [workspaceIndex]);

  const reloadFile = useCallback(async (filePath: string) => {
    try {
      const res = await fetch(`/api/files/read?workspaceIndex=${workspaceIndex}&path=${encodeURIComponent(filePath)}`);
      const data = await res.json();

      if (!data.ok) {
        // File was deleted or became inaccessible
        if (res.status === 404) {
          setOpenFiles((prev) =>
            prev.map((f) =>
              f.workspaceIndex === workspaceIndex && f.path === filePath
                ? { ...f, error: 'File was deleted', locked: false, loading: false }
                : f,
            ),
          );
        }
        return;
      }

      setOpenFiles((prev) =>
        prev.map((f) =>
          f.workspaceIndex === workspaceIndex && f.path === filePath
            ? {
                ...f,
                content: data.content,
                savedContent: data.content,
                dirty: false,
                // Preserve locked state — handleFileChanged manages lock lifecycle
                mtime: data.mtime,
                error: undefined,
              }
            : f,
        ),
      );
    } catch { /* ignore */ }
  }, [workspaceIndex]);

  /**
   * Handle an external file change event (from SSE `file.changed`).
   *
   * - If this was our own save → ignore (bounce-back dedup).
   * - If the file is open → lock it and reload content from disk.
   * - Lock clears automatically after a short delay (debounce rapid edits).
   */
  const unlockTimers = useRef<Map<string, number>>(new Map());

  // Clean up pending unlock timers on unmount
  useEffect(() => {
    const timers = unlockTimers.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const handleFileChanged = useCallback((changedPath: string) => {
    // Ignore bounce-back from our own saves
    const fileKey = makeFileKey(workspaceIndex, changedPath);
    if (recentSaveMtimes.current.has(fileKey)) return;
    if (savingPaths.current.has(fileKey)) return;

    // Check if file is open (use ref to avoid stale closure)
    const isOpen = openFilesRef.current.some(f => f.workspaceIndex === workspaceIndex && f.path === changedPath);
    if (!isOpen) return;

    // Lock the file immediately
    setOpenFiles((prev) =>
      prev.map(f =>
        f.workspaceIndex === workspaceIndex && f.path === changedPath ? { ...f, locked: true } : f,
      ),
    );

    // Reload content from disk
    reloadFile(changedPath).then(() => {
      // Clear any existing unlock timer (debounce rapid sequential edits)
      const existing = unlockTimers.current.get(fileKey);
      if (existing) clearTimeout(existing);

      // Unlock after 5s of no further changes — gives slow models time
      const timer = window.setTimeout(() => {
        unlockTimers.current.delete(fileKey);
        setOpenFiles((prev) =>
          prev.map(f =>
            f.workspaceIndex === workspaceIndex && f.path === changedPath ? { ...f, locked: false } : f,
          ),
        );
      }, 5000);
      unlockTimers.current.set(fileKey, timer);
    });
  }, [reloadFile, workspaceIndex]);

  /**
   * Remap open editor tabs when a file/folder path changes.
   * Supports prefix remaps for directory moves.
   */
  const remapOpenPaths = useCallback((fromPath: string, toPath: string) => {
    if (!fromPath || !toPath || fromPath === toPath) return;

    setOpenFiles((prev) => {
      const next = prev.map((f) => {
        if (!matchesPathPrefix(f.path, fromPath)) return f;
        const nextPath = remapPathPrefix(f.path, fromPath, toPath);
        return {
          ...f,
          path: nextPath,
          name: basename(nextPath),
        };
      });
      persistFiles(next);
      return next;
    });

    setActiveTabState((currentTab) => {
      if (!matchesPathPrefix(currentTab, fromPath)) return currentTab;
      const nextTab = remapPathPrefix(currentTab, fromPath, toPath);
      persistTab(nextTab);
      return nextTab;
    });
  }, []);

  /** Close any open tabs under a path prefix (file or folder). */
  const closeOpenPathsByPrefix = useCallback((pathPrefix: string) => {
    if (!pathPrefix) return;

    setOpenFiles((prev) => {
      const next = prev.filter((f) => !matchesPathPrefix(f.path, pathPrefix));
      persistFiles(next);
      return next;
    });

    setActiveTabState((currentTab) => {
      if (!matchesPathPrefix(currentTab, pathPrefix)) return currentTab;
      persistTab('chat');
      return 'chat';
    });
  }, []);

  return {
    openFiles,
    activeTab,
    setActiveTab,
    openFile,
    closeFile,
    updateContent,
    saveFile,
    reloadFile,
    initializeFiles,
    handleFileChanged,
    remapOpenPaths,
    closeOpenPathsByPrefix,
  };
}
