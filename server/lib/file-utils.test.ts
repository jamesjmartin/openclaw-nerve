/** Tests for file-utils helpers (resolveFsPath, parentPath). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveFsPath, parentPath } from './file-utils.js';

describe('resolveFsPath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-utils-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should resolve an absolute path to an existing file', async () => {
    const testFile = path.join(tmpDir, 'test.txt');
    await fs.writeFile(testFile, 'content');

    const resolved = await resolveFsPath(testFile);
    expect(resolved).toBeTruthy();
    expect(path.isAbsolute(resolved!)).toBe(true);
  });

  it('should resolve an absolute path to an existing directory', async () => {
    const testDir = path.join(tmpDir, 'subdir');
    await fs.mkdir(testDir);

    const resolved = await resolveFsPath(testDir);
    expect(resolved).toBeTruthy();
    expect(path.isAbsolute(resolved!)).toBe(true);
  });

  it('should return null for relative paths', async () => {
    const resolved = await resolveFsPath('relative/path.txt');
    expect(resolved).toBeNull();
  });

  it('should return null for non-existent paths by default', async () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist.txt');
    const resolved = await resolveFsPath(nonExistent);
    expect(resolved).toBeNull();
  });

  it('should allow non-existent paths when allowNonExistent is true', async () => {
    const nonExistent = path.join(tmpDir, 'new-file.txt');
    const resolved = await resolveFsPath(nonExistent, { allowNonExistent: true });
    expect(resolved).toBeTruthy();
    expect(resolved).toBe(nonExistent);
  });

  it('should return null for non-existent parent directory even with allowNonExistent', async () => {
    const nonExistentParent = path.join(tmpDir, 'missing-dir', 'file.txt');
    const resolved = await resolveFsPath(nonExistentParent, { allowNonExistent: true });
    expect(resolved).toBeNull();
  });

  it('should reject paths with excluded segments', async () => {
    const excludedDir = path.join(tmpDir, 'node_modules');
    await fs.mkdir(excludedDir);
    const testFile = path.join(excludedDir, 'package.json');
    await fs.writeFile(testFile, '{}');

    const resolved = await resolveFsPath(testFile);
    expect(resolved).toBeNull();
  });

  it('should reject paths with .git segments', async () => {
    const gitDir = path.join(tmpDir, '.git');
    await fs.mkdir(gitDir);
    const gitFile = path.join(gitDir, 'config');
    await fs.writeFile(gitFile, 'test');

    const resolved = await resolveFsPath(gitFile);
    expect(resolved).toBeNull();
  });

  it('should reject paths with .env segments', async () => {
    const envFile = path.join(tmpDir, '.env');
    await fs.writeFile(envFile, 'SECRET=value');

    const resolved = await resolveFsPath(envFile);
    expect(resolved).toBeNull();
  });

  it('should resolve symlinks and re-check exclusions', async () => {
    // Create an excluded directory
    const excludedDir = path.join(tmpDir, 'node_modules');
    await fs.mkdir(excludedDir);
    const targetFile = path.join(excludedDir, 'target.txt');
    await fs.writeFile(targetFile, 'content');

    // Create a symlink outside the excluded dir pointing to the excluded file
    const symlinkPath = path.join(tmpDir, 'link.txt');
    await fs.symlink(targetFile, symlinkPath);

    // Should be rejected because realpath resolves to excluded location
    const resolved = await resolveFsPath(symlinkPath);
    expect(resolved).toBeNull();
  });

  it('should accept symlinks that resolve to allowed locations', async () => {
    const targetFile = path.join(tmpDir, 'target.txt');
    await fs.writeFile(targetFile, 'content');

    const symlinkPath = path.join(tmpDir, 'link.txt');
    await fs.symlink(targetFile, symlinkPath);

    const resolved = await resolveFsPath(symlinkPath);
    expect(resolved).toBeTruthy();
    // Should return the symlink path itself (not the target) to preserve symlink semantics
    const normalizedSymlink = path.normalize(symlinkPath);
    expect(resolved).toBe(normalizedSymlink);
  });
});

describe('parentPath', () => {
  it('should return parent directory for a simple path', () => {
    expect(parentPath('/home/user/file.txt')).toBe('/home/user');
  });

  it('should return parent directory for a directory path', () => {
    expect(parentPath('/home/user/docs')).toBe('/home/user');
  });

  it('should handle trailing slashes', () => {
    expect(parentPath('/home/user/docs/')).toBe('/home/user');
  });

  it('should return root for paths at root level', () => {
    expect(parentPath('/home')).toBe('/');
  });

  it('should return root when already at root', () => {
    expect(parentPath('/')).toBe('/');
  });

  it('should handle Windows drive roots', () => {
    expect(parentPath('C:/')).toBe('C:/');
    expect(parentPath('D:/')).toBe('D:/');
  });

  it('should handle Windows paths with backslashes', () => {
    expect(parentPath('C:\\Users\\user\\file.txt')).toBe('C:/Users/user');
  });

  it('should handle Windows paths at drive level', () => {
    expect(parentPath('C:\\Users')).toBe('C:/');
  });

  it('should handle empty string', () => {
    expect(parentPath('')).toBe('');
  });

  it('should handle paths with multiple trailing slashes', () => {
    // Multiple trailing slashes are collapsed to single slash, then trimmed
    // /home/user/// -> /home/user/ -> /home/user -> parent is /home
    expect(parentPath('/home/user///')).toBe('/home');
  });

  it('should handle single-level paths', () => {
    expect(parentPath('/home')).toBe('/');
  });
});
