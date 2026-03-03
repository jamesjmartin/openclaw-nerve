/** Tests for file-utils workspace functions. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('file-utils', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-utils-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getWorkspaceRoots', () => {
    it('returns single default workspace when no env var', async () => {
      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: null,
        },
      }));

      const { getWorkspaceRoots } = await import('./file-utils.js');
      const roots = getWorkspaceRoots();

      expect(roots).toHaveLength(1);
      expect(roots[0]).toBe(tmpDir);
    });

    it('returns multiple workspaces from env var', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');
      const workspace2 = path.join(tmpDir, 'workspace2');

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
      }));

      const { getWorkspaceRoots } = await import('./file-utils.js');
      const roots = getWorkspaceRoots();

      expect(roots).toHaveLength(2);
      expect(roots[0]).toBe(workspace1);
      expect(roots[1]).toBe(workspace2);
    });

    it('filters empty paths from env var', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1}, , `,
        },
      }));

      const { getWorkspaceRoots } = await import('./file-utils.js');
      const roots = getWorkspaceRoots();

      expect(roots).toHaveLength(1);
      expect(roots[0]).toBe(workspace1);
    });

    it('trims whitespace from paths', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');
      const workspace2 = path.join(tmpDir, 'workspace2');

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: `  ${workspace1}  , ${workspace2}  `,
        },
      }));

      const { getWorkspaceRoots } = await import('./file-utils.js');
      const roots = getWorkspaceRoots();

      expect(roots).toHaveLength(2);
      expect(roots[0]).toBe(workspace1);
      expect(roots[1]).toBe(workspace2);
    });
  });

  describe('getWorkspaceRoot', () => {
    it('returns first workspace by default', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');
      const workspace2 = path.join(tmpDir, 'workspace2');

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
      }));

      const { getWorkspaceRoot } = await import('./file-utils.js');
      const root = getWorkspaceRoot();

      expect(root).toBe(workspace1);
    });

    it('returns workspace at specified index', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');
      const workspace2 = path.join(tmpDir, 'workspace2');

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
      }));

      const { getWorkspaceRoot } = await import('./file-utils.js');
      const root = getWorkspaceRoot(1);

      expect(root).toBe(workspace2);
    });

    it('returns first workspace when index out of bounds', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: workspace1,
        },
      }));

      const { getWorkspaceRoot } = await import('./file-utils.js');
      const root = getWorkspaceRoot(99);

      expect(root).toBe(workspace1);
    });
  });

  describe('isCustomWorkspace', () => {
    it('returns false when no env var', async () => {
      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: null,
        },
      }));

      const { isCustomWorkspace } = await import('./file-utils.js');
      const result = isCustomWorkspace();

      expect(result).toBe(false);
    });

    it('returns true when env var is set', async () => {
      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: '/home/user/workspace',
        },
      }));

      const { isCustomWorkspace } = await import('./file-utils.js');
      const result = isCustomWorkspace();

      expect(result).toBe(true);
    });

    it('returns false when env var is empty string', async () => {
      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: '',
        },
      }));

      const { isCustomWorkspace } = await import('./file-utils.js');
      const result = isCustomWorkspace();

      expect(result).toBe(false);
    });

    it('returns true for multiple workspaces', async () => {
      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: '/home/user/workspace1,/home/user/workspace2',
        },
      }));

      const { isCustomWorkspace } = await import('./file-utils.js');
      const result = isCustomWorkspace();

      expect(result).toBe(true);
    });
  });

  describe('resolveWorkspacePath with workspace index', () => {
    it('resolves path in specified workspace', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');
      const workspace2 = path.join(tmpDir, 'workspace2');
      await fs.mkdir(workspace1);
      await fs.mkdir(workspace2);
      await fs.writeFile(path.join(workspace2, 'test.md'), 'content');

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
      }));

      const { resolveWorkspacePath } = await import('./file-utils.js');
      const resolved = await resolveWorkspacePath('test.md', { workspaceIndex: 1 });

      expect(resolved).toBe(path.join(workspace2, 'test.md'));
    });

    it('rejects path traversal across workspaces', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');
      const workspace2 = path.join(tmpDir, 'workspace2');
      await fs.mkdir(workspace1);
      await fs.mkdir(workspace2);

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
      }));

      const { resolveWorkspacePath } = await import('./file-utils.js');
      const resolved = await resolveWorkspacePath('../../etc/passwd', { workspaceIndex: 0 });

      expect(resolved).toBeNull();
    });

    it('defaults to workspace 0 when index not provided', async () => {
      const workspace1 = path.join(tmpDir, 'workspace1');
      await fs.mkdir(workspace1);
      await fs.writeFile(path.join(workspace1, 'test.md'), 'content');

      vi.doMock('./config.js', () => ({
        config: {
          memoryPath: path.join(tmpDir, 'MEMORY.md'),
          fileBrowserPaths: workspace1,
        },
      }));

      const { resolveWorkspacePath } = await import('./file-utils.js');
      const resolved = await resolveWorkspacePath('test.md');

      expect(resolved).toBe(path.join(workspace1, 'test.md'));
    });
  });
});
