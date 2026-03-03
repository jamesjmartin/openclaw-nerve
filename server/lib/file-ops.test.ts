/** Tests for file-ops — deleteEntry and multi-workspace toWorkspaceRelative. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('file-ops', () => {
  let tmpDir: string;
  let customDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fops-test-'));
    customDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fops-custom-'));
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Memories\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(customDir, { recursive: true, force: true });
  });

  async function loadModule(configOverrides: Record<string, unknown> = {}) {
    vi.doMock('./config.js', () => ({
      config: {
        memoryPath: path.join(tmpDir, 'MEMORY.md'),
        fileBrowserPaths: '',
        ...configOverrides,
      },
    }));
    return import('./file-ops.js');
  }

  describe('deleteEntry', () => {
    it('permanently deletes a file', async () => {
      const filePath = path.join(tmpDir, 'delete-me.md');
      await fs.writeFile(filePath, 'bye');

      const mod = await loadModule();
      const result = await mod.deleteEntry({ path: 'delete-me.md' });
      expect(result.from).toBe('delete-me.md');
      expect(result.to).toBe('');

      // File should be gone
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('permanently deletes a directory recursively', async () => {
      const dirPath = path.join(tmpDir, 'delete-dir');
      await fs.mkdir(dirPath);
      await fs.writeFile(path.join(dirPath, 'child.md'), 'child');

      const mod = await loadModule();
      const result = await mod.deleteEntry({ path: 'delete-dir' });
      expect(result.from).toBe('delete-dir');

      await expect(fs.access(dirPath)).rejects.toThrow();
    });

    it('rejects deletion of non-existent file', async () => {
      const mod = await loadModule();
      await expect(mod.deleteEntry({ path: 'nonexistent.md' })).rejects.toThrow();
    });

    it('rejects deletion of protected .trash root', async () => {
      await fs.mkdir(path.join(tmpDir, '.trash'), { recursive: true });
      const mod = await loadModule();
      await expect(mod.deleteEntry({ path: '.trash' })).rejects.toThrow();
    });

    it('works with absolute paths in custom workspace', async () => {
      const filePath = path.join(customDir, 'custom-file.md');
      await fs.writeFile(filePath, 'custom content');

      const mod = await loadModule({ fileBrowserPaths: `${customDir},${tmpDir}` });
      const result = await mod.deleteEntry({ path: filePath });
      expect(result.from).toBe('custom-file.md');
      expect(result.to).toBe('');

      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('rejects absolute paths outside all workspace roots', async () => {
      const mod = await loadModule({ fileBrowserPaths: customDir });
      await expect(mod.deleteEntry({ path: '/etc/passwd' })).rejects.toThrow();
    });
  });

  describe('trashEntry (regression)', () => {
    it('still works for default workspace files', async () => {
      await fs.writeFile(path.join(tmpDir, 'trash-me.md'), 'trash this');

      const mod = await loadModule();
      const result = await mod.trashEntry({ path: 'trash-me.md' });
      expect(result.from).toBe('trash-me.md');
      expect(result.to).toMatch(/^\.trash\//);

      // Original should be gone
      await expect(fs.access(path.join(tmpDir, 'trash-me.md'))).rejects.toThrow();
      // Should exist in .trash
      const trashPath = path.join(tmpDir, result.to);
      await expect(fs.access(trashPath)).resolves.toBeUndefined();
    });
  });

  describe('renameEntry (regression)', () => {
    it('still works for default workspace files', async () => {
      await fs.writeFile(path.join(tmpDir, 'old-name.md'), 'content');

      const mod = await loadModule();
      const result = await mod.renameEntry({ path: 'old-name.md', newName: 'new-name.md' });
      expect(result.from).toBe('old-name.md');
      expect(result.to).toBe('new-name.md');
    });
  });

  describe('moveEntry (regression)', () => {
    it('still works for default workspace files', async () => {
      await fs.mkdir(path.join(tmpDir, 'target-dir'));
      await fs.writeFile(path.join(tmpDir, 'move-me.md'), 'moving');

      const mod = await loadModule();
      const result = await mod.moveEntry({ sourcePath: 'move-me.md', targetDirPath: 'target-dir' });
      expect(result.from).toBe('move-me.md');
      expect(result.to).toBe('target-dir/move-me.md');
    });
  });
});
