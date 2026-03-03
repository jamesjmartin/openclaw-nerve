/** Tests for file-ops deleteEntry function. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('file-ops', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-ops-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function setupMocks() {
    vi.doMock('./config.js', () => ({
      config: {
        memoryPath: path.join(tmpDir, 'MEMORY.md'),
        fileBrowserPaths: null,
      },
    }));
  }

  describe('deleteEntry', () => {
    it('permanently deletes a file', async () => {
      await setupMocks();
      const testFile = path.join(tmpDir, 'test.md');
      await fs.writeFile(testFile, 'content');

      const { deleteEntry } = await import('./file-ops.js');
      const result = await deleteEntry({ path: 'test.md' });

      expect(result.from).toBe('test.md');
      expect(result.to).toBe('');
      await expect(fs.access(testFile)).rejects.toThrow();
    });

    it('permanently deletes a directory', async () => {
      await setupMocks();
      const testDir = path.join(tmpDir, 'testdir');
      await fs.mkdir(testDir);
      await fs.writeFile(path.join(testDir, 'file.md'), 'content');

      const { deleteEntry } = await import('./file-ops.js');
      const result = await deleteEntry({ path: 'testdir' });

      expect(result.from).toBe('testdir');
      expect(result.to).toBe('');
      await expect(fs.access(testDir)).rejects.toThrow();
    });

    it('deletes directory with nested content', async () => {
      await setupMocks();
      const testDir = path.join(tmpDir, 'parent');
      const nestedDir = path.join(testDir, 'child');
      await fs.mkdir(testDir);
      await fs.mkdir(nestedDir);
      await fs.writeFile(path.join(nestedDir, 'file.md'), 'content');

      const { deleteEntry } = await import('./file-ops.js');
      const result = await deleteEntry({ path: 'parent' });

      expect(result.from).toBe('parent');
      expect(result.to).toBe('');
      await expect(fs.access(testDir)).rejects.toThrow();
    });

    it('throws error for non-existent file', async () => {
      await setupMocks();

      const { deleteEntry } = await import('./file-ops.js');
      
      await expect(deleteEntry({ path: 'nonexistent.md' })).rejects.toThrow();
    });

    it('throws error for path traversal attempts', async () => {
      await setupMocks();

      const { deleteEntry } = await import('./file-ops.js');
      
      await expect(deleteEntry({ path: '../../etc/passwd' })).rejects.toThrow();
    });

    it('throws error when trying to delete .trash directory', async () => {
      await setupMocks();
      const trashDir = path.join(tmpDir, '.trash');
      await fs.mkdir(trashDir);

      const { deleteEntry } = await import('./file-ops.js');
      
      await expect(deleteEntry({ path: '.trash' })).rejects.toThrow();
    });

    it('allows deleting files inside .trash (permanent cleanup)', async () => {
      await setupMocks();
      const trashDir = path.join(tmpDir, '.trash');
      await fs.mkdir(trashDir);
      await fs.writeFile(path.join(trashDir, 'file.md'), 'content');

      const { deleteEntry } = await import('./file-ops.js');
      
      const result = await deleteEntry({ path: '.trash/file.md' });
      expect(result.from).toBe('.trash/file.md');
      expect(result.to).toBe('');
      await expect(fs.access(path.join(trashDir, 'file.md'))).rejects.toThrow();
    });

    it('respects workspace boundaries', async () => {
      await setupMocks();
      
      // Create file outside workspace
      const outsideFile = path.join(os.tmpdir(), 'outside.md');
      await fs.writeFile(outsideFile, 'content');

      const { deleteEntry } = await import('./file-ops.js');
      
      // Attempt to delete file outside workspace should fail
      await expect(deleteEntry({ path: '../outside.md' })).rejects.toThrow();

      // Verify file still exists
      await expect(fs.access(outsideFile)).resolves.toBeUndefined();
      
      // Cleanup
      await fs.unlink(outsideFile);
    });
  });

  describe('trashEntry vs deleteEntry', () => {
    it('trashEntry moves to .trash, deleteEntry removes permanently', async () => {
      await setupMocks();
      
      // Create two test files
      await fs.writeFile(path.join(tmpDir, 'trash-me.md'), 'trash content');
      await fs.writeFile(path.join(tmpDir, 'delete-me.md'), 'delete content');

      const { trashEntry, deleteEntry } = await import('./file-ops.js');

      // Trash one file
      const trashResult = await trashEntry({ path: 'trash-me.md' });
      expect(trashResult.to.startsWith('.trash/')).toBe(true);
      
      // Verify it's in trash
      const trashPath = path.join(tmpDir, trashResult.to);
      await expect(fs.access(trashPath)).resolves.toBeUndefined();

      // Delete the other file
      const deleteResult = await deleteEntry({ path: 'delete-me.md' });
      expect(deleteResult.to).toBe('');
      
      // Verify it's gone
      await expect(fs.access(path.join(tmpDir, 'delete-me.md'))).rejects.toThrow();
    });
  });
});
