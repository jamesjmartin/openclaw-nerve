/** Tests for useFileTree hook - workspace info handling and tree operations. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useFileTree } from './useFileTree';
import type { TreeEntry } from '../types';

// Mock fetch globally
global.fetch = vi.fn();

describe('useFileTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock localStorage
    const localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };
    vi.stubGlobal('localStorage', localStorageMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('workspace info handling', () => {
    it('initializes with null workspaceInfo', () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, entries: [] }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      expect(result.current.workspaceInfo).toBeNull();
    });

    it('sets workspaceInfo when API response includes it', async () => {
      const mockWorkspaceInfo = {
        isCustomWorkspace: true,
        rootPath: '/home/user/custom-workspace',
      };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { name: 'file.txt', path: 'file.txt', type: 'file' as const, children: null },
          ],
          workspaceInfo: mockWorkspaceInfo,
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.workspaceInfo).toEqual(mockWorkspaceInfo);
      });
    });

    it('sets workspaceInfo with default workspace when not using custom workspace', async () => {
      const mockWorkspaceInfo = {
        isCustomWorkspace: false,
        rootPath: '/home/user/.openclaw/workspace',
      };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { name: 'src', path: 'src', type: 'directory' as const, children: null },
          ],
          workspaceInfo: mockWorkspaceInfo,
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.workspaceInfo).toEqual(mockWorkspaceInfo);
      });
    });

    it('handles API response without workspaceInfo gracefully', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { name: 'package.json', path: 'package.json', type: 'file' as const, children: null },
          ],
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
        expect(result.current.workspaceInfo).toBeNull();
      });
    });

    it('updates workspaceInfo when subsequent calls return different info', async () => {
      const mockFetch = vi.mocked(fetch);
      
      // First call - custom workspace
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [],
          workspaceInfo: {
            isCustomWorkspace: true,
            rootPath: '/custom/path',
          },
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.workspaceInfo?.isCustomWorkspace).toBe(true);
      });

      // Second call - default workspace
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [],
          workspaceInfo: {
            isCustomWorkspace: false,
            rootPath: '/default/path',
          },
        }),
      } as Response);

      // Trigger a refresh
      result.current.refresh();

      await waitFor(() => {
        expect(result.current.workspaceInfo?.isCustomWorkspace).toBe(false);
        expect(result.current.workspaceInfo?.rootPath).toBe('/default/path');
      });
    });
  });

  describe('existing functionality still works', () => {
    it('loads entries on mount', async () => {
      const mockEntries: TreeEntry[] = [
        { name: 'src', path: 'src', type: 'directory', children: null },
        { name: 'package.json', path: 'package.json', type: 'file', children: null },
      ];

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: mockEntries,
          workspaceInfo: { isCustomWorkspace: false, rootPath: '/workspace' },
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      expect(result.current.loading).toBe(true);

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.entries).toEqual(mockEntries);
      });
    });

    it('handles fetch errors gracefully', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeTruthy();
      });
    });

    it('handles API error responses', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server error' }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.entries).toEqual([]);
      });
    });

    it('toggles directory expansion', async () => {
      const mockFetch = vi.mocked(fetch);
      
      // Initial load
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { name: 'src', path: 'src', type: 'directory', children: null },
          ],
          workspaceInfo: { isCustomWorkspace: false, rootPath: '/workspace' },
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
      });

      // Toggle directory
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { name: 'index.ts', path: 'src/index.ts', type: 'file', children: null },
          ],
        }),
      } as Response);

      result.current.toggleDirectory('src');

      await waitFor(() => {
        expect(result.current.expandedPaths.has('src')).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('?path=src&depth=1')
        );
      });
    });

    it('selects files', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [
            { name: 'test.txt', path: 'test.txt', type: 'file', children: null },
          ],
          workspaceInfo: { isCustomWorkspace: false, rootPath: '/workspace' },
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
      });

      result.current.selectFile('test.txt');
      // Test that the function can be called without throwing
      expect(typeof result.current.selectFile).toBe('function');
    });

    it('persists expanded paths in localStorage', async () => {
      const mockLocalStorage = vi.mocked(localStorage);
      mockLocalStorage.getItem.mockReturnValue('["src","components"]');

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [],
          workspaceInfo: { isCustomWorkspace: false, rootPath: '/workspace' },
        }),
      } as Response);

      renderHook(() => useFileTree());

      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('nerve-file-tree-expanded');
    });

    it('removes stale expanded paths when a persisted directory reload fails', async () => {
      const mockLocalStorage = vi.mocked(localStorage);
      mockLocalStorage.getItem.mockReturnValue('["stale-dir"]');

      const mockFetch = vi.mocked(fetch);
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            entries: [],
            workspaceInfo: { isCustomWorkspace: false, rootPath: '/workspace' },
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        } as Response);

      const { result } = renderHook(() => useFileTree());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await waitFor(() => {
        expect(result.current.expandedPaths.has('stale-dir')).toBe(false);
      });

      expect(mockLocalStorage.setItem).toHaveBeenLastCalledWith(
        'nerve-file-tree-expanded',
        JSON.stringify([]),
      );
    });
  });

  describe('return object includes workspaceInfo', () => {
    it('exports workspaceInfo in the return object', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [],
          workspaceInfo: { isCustomWorkspace: true, rootPath: '/custom' },
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      // Check that workspaceInfo is in the return object
      expect('workspaceInfo' in result.current).toBe(true);
      expect(result.current.workspaceInfo).toBeNull(); // Initially null

      await waitFor(() => {
        expect(result.current.workspaceInfo).toEqual({
          isCustomWorkspace: true,
          rootPath: '/custom',
        });
      });
    });

    it('includes all expected return properties', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          entries: [],
          workspaceInfo: { isCustomWorkspace: false, rootPath: '/workspace' },
        }),
      } as Response);

      const { result } = renderHook(() => useFileTree());

      const returnKeys = Object.keys(result.current);
      const expectedKeys = [
        'entries',
        'loading',
        'error',
        'expandedPaths',
        'selectedPath',
        'loadingPaths',
        'workspaceInfo',
        'toggleDirectory',
        'selectFile',
        'refresh',
        'handleFileChange',
      ];

      expect(returnKeys).toEqual(expect.arrayContaining(expectedKeys));
      expect(returnKeys).toHaveLength(expectedKeys.length);
    });
  });
});
