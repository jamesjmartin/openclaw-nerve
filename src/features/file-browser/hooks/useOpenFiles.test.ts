import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useOpenFiles } from './useOpenFiles';

global.fetch = vi.fn();

describe('useOpenFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const localStorageMock = {
      getItem: vi.fn((key: string) => {
        if (key === 'nerve-open-files') return null;
        if (key === 'nerve-active-tab') return 'chat';
        return null;
      }),
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

  it('filters invalid persisted files during initialization and persists only valid ones', async () => {
    const mockLocalStorage = vi.mocked(localStorage);
    mockLocalStorage.getItem.mockImplementation((key: string) => {
      if (key === 'nerve-open-files') return '["valid.txt","missing.txt"]';
      if (key === 'nerve-active-tab') return 'chat';
      return null;
    });

    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, content: 'hello', mtime: 123 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

    const { result } = renderHook(() => useOpenFiles());

    await act(async () => {
      await result.current.initializeFiles();
    });

    await waitFor(() => {
      expect(result.current.openFiles).toHaveLength(1);
      expect(result.current.openFiles[0]?.path).toBe('valid.txt');
    });

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'nerve-open-files',
      JSON.stringify(['valid.txt']),
    );
  });

  it('persists an empty file list when all persisted files are invalid', async () => {
    const mockLocalStorage = vi.mocked(localStorage);
    mockLocalStorage.getItem.mockImplementation((key: string) => {
      if (key === 'nerve-open-files') return '["missing.txt"]';
      if (key === 'nerve-active-tab') return 'chat';
      return null;
    });

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const { result } = renderHook(() => useOpenFiles());

    await act(async () => {
      await result.current.initializeFiles();
    });

    await waitFor(() => {
      expect(result.current.openFiles).toEqual([]);
    });

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'nerve-open-files',
      JSON.stringify([]),
    );
  });

  it('removes a file tab when openFile receives a non-ok response', async () => {
    const mockLocalStorage = vi.mocked(localStorage);
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const { result } = renderHook(() => useOpenFiles());

    await act(async () => {
      await result.current.openFile('missing.txt');
    });

    await waitFor(() => {
      expect(result.current.openFiles).toEqual([]);
    });

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('nerve-active-tab', 'missing.txt');
  });
});
