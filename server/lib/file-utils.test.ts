/** Tests for file-utils — workspace roots, isCustomWorkspace, resolveWorkspacePath. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('file-utils', () => {
  let tmpDir: string;
  let customDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'futils-test-'));
    customDir = await fs.mkdtemp(path.join(os.tmpdir(), 'futils-custom-'));
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Memories\n');
    await fs.writeFile(path.join(customDir, 'hello.txt'), 'hello');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(customDir, { recursive: true, force: true });
  });

  function mockConfig(overrides: Record<string, unknown> = {}) {
    return {
      memoryPath: path.join(tmpDir, 'MEMORY.md'),
      fileBrowserPaths: '',
      ...overrides,
    };
  }

  async function loadModule(configOverrides: Record<string, unknown> = {}) {
    vi.doMock('./config.js', () => ({ config: mockConfig(configOverrides) }));
    return import('./file-utils.js');
  }

  describe('getWorkspaceRoot', () => {
    it('returns parent of memoryPath', async () => {
      const mod = await loadModule();
      expect(mod.getWorkspaceRoot()).toBe(tmpDir);
    });
  });

  describe('getWorkspaceRoots', () => {
    it('returns default root when NERVE_WORKSPACE_PATHS is empty', async () => {
      const mod = await loadModule();
      expect(mod.getWorkspaceRoots()).toEqual([tmpDir]);
    });

    it('returns custom paths when configured', async () => {
      const mod = await loadModule({ fileBrowserPaths: `${customDir},${tmpDir}` });
      expect(mod.getWorkspaceRoots()).toEqual([customDir, tmpDir]);
    });

    it('trims whitespace from paths', async () => {
      const mod = await loadModule({ fileBrowserPaths: `  ${customDir} , ${tmpDir}  ` });
      expect(mod.getWorkspaceRoots()).toEqual([customDir, tmpDir]);
    });

    it('filters empty segments', async () => {
      const mod = await loadModule({ fileBrowserPaths: `${customDir},,` });
      expect(mod.getWorkspaceRoots()).toEqual([customDir]);
    });
  });

  describe('isCustomWorkspace', () => {
    it('returns false when fileBrowserPaths is empty', async () => {
      const mod = await loadModule();
      expect(mod.isCustomWorkspace()).toBe(false);
    });

    it('returns true when fileBrowserPaths has valid paths', async () => {
      const mod = await loadModule({ fileBrowserPaths: customDir });
      expect(mod.isCustomWorkspace()).toBe(true);
    });

    it('returns false when fileBrowserPaths is only whitespace/commas', async () => {
      const mod = await loadModule({ fileBrowserPaths: ' , , ' });
      expect(mod.isCustomWorkspace()).toBe(false);
    });
  });

  describe('findWorkspaceRootForPath', () => {
    it('returns matching root for path within workspace', async () => {
      const mod = await loadModule({ fileBrowserPaths: `${customDir},${tmpDir}` });
      const filePath = path.join(customDir, 'hello.txt');
      expect(mod.findWorkspaceRootForPath(filePath)).toBe(customDir);
    });

    it('returns null for path outside all workspaces', async () => {
      const mod = await loadModule({ fileBrowserPaths: customDir });
      expect(mod.findWorkspaceRootForPath('/some/other/path')).toBeNull();
    });

    it('returns root when path equals root exactly', async () => {
      const mod = await loadModule({ fileBrowserPaths: customDir });
      expect(mod.findWorkspaceRootForPath(customDir)).toBe(customDir);
    });
  });

  describe('resolveWorkspacePath', () => {
    it('resolves relative paths against default workspace', async () => {
      const mod = await loadModule();
      const result = await mod.resolveWorkspacePath('MEMORY.md');
      expect(result).toBe(path.join(tmpDir, 'MEMORY.md'));
    });

    it('rejects relative path traversal', async () => {
      const mod = await loadModule();
      const result = await mod.resolveWorkspacePath('../../../etc/passwd');
      expect(result).toBeNull();
    });

    it('rejects absolute paths outside workspace roots', async () => {
      const mod = await loadModule();
      const result = await mod.resolveWorkspacePath('/etc/passwd');
      expect(result).toBeNull();
    });

    it('accepts absolute paths within a configured workspace root', async () => {
      const mod = await loadModule({ fileBrowserPaths: `${customDir},${tmpDir}` });
      const absPath = path.join(customDir, 'hello.txt');
      const result = await mod.resolveWorkspacePath(absPath);
      expect(result).toBe(absPath);
    });

    it('rejects absolute paths outside all configured roots', async () => {
      const mod = await loadModule({ fileBrowserPaths: customDir });
      const absPath = path.join(tmpDir, 'MEMORY.md');
      const result = await mod.resolveWorkspacePath(absPath);
      expect(result).toBeNull();
    });

    it('allows non-existent files with allowNonExistent option', async () => {
      const mod = await loadModule();
      const result = await mod.resolveWorkspacePath('new-file.md', { allowNonExistent: true });
      expect(result).toBe(path.join(tmpDir, 'new-file.md'));
    });

    it('rejects excluded paths', async () => {
      const mod = await loadModule();
      const result = await mod.resolveWorkspacePath('node_modules/package.json');
      expect(result).toBeNull();
    });

    it('rejects absolute paths with excluded segments', async () => {
      await fs.mkdir(path.join(customDir, 'node_modules'), { recursive: true });
      const mod = await loadModule({ fileBrowserPaths: customDir });
      const absPath = path.join(customDir, 'node_modules', 'package.json');
      const result = await mod.resolveWorkspacePath(absPath);
      expect(result).toBeNull();
    });
  });
});
