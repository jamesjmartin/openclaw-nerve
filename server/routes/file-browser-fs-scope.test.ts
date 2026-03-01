/** Tests for filesystem-scope file operations (rename, move, delete). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const toPosix = (p: string) => p.replace(/\\/g, '/');

describe('file-browser fs-scope operations', () => {
  let tmpDir: string;
  let fsTestDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowser-test-'));
    fsTestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-scope-test-'));
    // Create a MEMORY.md in the tmpDir so getWorkspaceRoot returns tmpDir
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Memories\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(fsTestDir, { recursive: true, force: true });
  });

  async function buildApp() {
    vi.doMock('../lib/config.js', () => ({
      config: {
        auth: false, port: 3000, host: '127.0.0.1', sslPort: 3443,
        memoryPath: path.join(tmpDir, 'MEMORY.md'),
      },
      SESSION_COOKIE_NAME: 'nerve_session_3000',
    }));

    const mod = await import('./file-browser.js');
    const app = new Hono();
    app.route('/', mod.default);
    return app;
  }

  describe('POST /api/files/rename with scope=fs', () => {
    it('renames a file outside workspace', async () => {
      const testFile = path.join(fsTestDir, 'original.txt');
      await fs.writeFile(testFile, 'content');

      const app = await buildApp();
      const res = await app.request('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: testFile,
          newName: 'renamed.txt',
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; from: string; to: string };
      expect(json.ok).toBe(true);
      expect(json.from).toBe(testFile);
      expect(json.to).toBe(toPosix(path.join(fsTestDir, 'renamed.txt')));

      // Verify file was renamed
      const exists = await fs.access(path.join(fsTestDir, 'renamed.txt')).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('rejects rename with invalid name', async () => {
      const testFile = path.join(fsTestDir, 'test.txt');
      await fs.writeFile(testFile, 'content');

      const app = await buildApp();
      const res = await app.request('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: testFile,
          newName: '../escape.txt',
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/files/move with scope=fs', () => {
    it('moves a file outside workspace', async () => {
      const sourceFile = path.join(fsTestDir, 'source.txt');
      const targetDir = path.join(fsTestDir, 'subdir');
      await fs.writeFile(sourceFile, 'content');
      await fs.mkdir(targetDir);

      const app = await buildApp();
      const res = await app.request('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath: sourceFile,
          targetDirPath: targetDir,
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; from: string; to: string };
      expect(json.ok).toBe(true);
      expect(json.from).toBe(sourceFile);
      expect(json.to).toBe(toPosix(path.join(targetDir, 'source.txt')));

      // Verify file was moved
      const exists = await fs.access(path.join(targetDir, 'source.txt')).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('rejects move to non-directory', async () => {
      const sourceFile = path.join(fsTestDir, 'source.txt');
      const targetFile = path.join(fsTestDir, 'target.txt');
      await fs.writeFile(sourceFile, 'content');
      await fs.writeFile(targetFile, 'target');

      const app = await buildApp();
      const res = await app.request('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath: sourceFile,
          targetDirPath: targetFile,
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/files/delete with scope=fs', () => {
    it('permanently deletes a file outside workspace', async () => {
      const testFile = path.join(fsTestDir, 'delete-me.txt');
      await fs.writeFile(testFile, 'content');

      const app = await buildApp();
      const res = await app.request('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: testFile,
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; path: string };
      expect(json.ok).toBe(true);
      expect(json.path).toBe(testFile);

      // Verify file was deleted
      const exists = await fs.access(testFile).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('permanently deletes a directory outside workspace', async () => {
      const testDir = path.join(fsTestDir, 'delete-dir');
      await fs.mkdir(testDir);
      await fs.writeFile(path.join(testDir, 'file.txt'), 'content');

      const app = await buildApp();
      const res = await app.request('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: testDir,
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; path: string };
      expect(json.ok).toBe(true);

      // Verify directory was deleted
      const exists = await fs.access(testDir).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('rejects delete with workspace scope', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'some-file.txt',
          scope: 'workspace',
        }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('filesystem scope');
    });
  });

  describe('POST /api/files/trash with scope=fs', () => {
    it('rejects trash operation for filesystem scope', async () => {
      const testFile = path.join(fsTestDir, 'test.txt');
      await fs.writeFile(testFile, 'content');

      const app = await buildApp();
      const res = await app.request('/api/files/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: testFile,
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('not supported');
    });
  });

  describe('GET /api/files/tree with scope=fs', () => {
    it('lists directory entries outside workspace', async () => {
      await fs.writeFile(path.join(fsTestDir, 'external.txt'), 'content');
      await fs.mkdir(path.join(fsTestDir, 'external-dir'));

      const app = await buildApp();
      const res = await app.request(`/api/files/tree?scope=fs&path=${encodeURIComponent(fsTestDir)}`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; entries: Array<{ name: string; path: string }> };
      expect(json.ok).toBe(true);

      const names = json.entries.map(e => e.name);
      expect(names).toContain('external.txt');
      expect(names).toContain('external-dir');

      // Paths should be normalized to forward slashes
      const paths = json.entries.map(e => e.path);
      paths.forEach(p => {
        expect(p).not.toContain('\\');
      });
    });
  });

  describe('GET /api/files/read with scope=fs', () => {
    it('reads a file outside workspace', async () => {
      const testFile = path.join(fsTestDir, 'read-test.txt');
      await fs.writeFile(testFile, 'Hello from fs scope');

      const app = await buildApp();
      const res = await app.request(`/api/files/read?scope=fs&path=${encodeURIComponent(testFile)}`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; content: string };
      expect(json.ok).toBe(true);
      expect(json.content).toBe('Hello from fs scope');
    });

    it('rejects reading excluded directories', async () => {
      const nodeModules = path.join(fsTestDir, 'node_modules');
      await fs.mkdir(nodeModules);
      const excludedFile = path.join(nodeModules, 'package.json');
      await fs.writeFile(excludedFile, '{}');

      const app = await buildApp();
      const res = await app.request(`/api/files/read?scope=fs&path=${encodeURIComponent(excludedFile)}`);
      expect(res.status).toBe(403);
    });

    it('rejects relative paths for fs scope', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/read?scope=fs&path=relative/path.txt');
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/files/write with scope=fs', () => {
    it('writes a file outside workspace', async () => {
      const testFile = path.join(fsTestDir, 'write-test.txt');

      const app = await buildApp();
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: testFile,
          content: 'Written via fs scope',
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);

      // Verify file was written
      const content = await fs.readFile(testFile, 'utf-8');
      expect(content).toBe('Written via fs scope');
    });

    it('rejects writing to excluded directories', async () => {
      const nodeModules = path.join(fsTestDir, 'node_modules');
      await fs.mkdir(nodeModules);
      const excludedFile = path.join(nodeModules, 'test.txt');

      const app = await buildApp();
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: excludedFile,
          content: 'Should fail',
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(403);
    });

    it('rejects relative paths for fs scope', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'relative/path.txt',
          content: 'test',
          scope: 'fs',
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/files/raw with scope=fs', () => {
    it('serves raw file content outside workspace', async () => {
      const testFile = path.join(fsTestDir, 'raw-test.png');
      await fs.writeFile(testFile, Buffer.from('fake-png-data'));

      const app = await buildApp();
      const res = await app.request(`/api/files/raw?scope=fs&path=${encodeURIComponent(testFile)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
    });

    it('rejects serving excluded files', async () => {
      const gitDir = path.join(fsTestDir, '.git');
      await fs.mkdir(gitDir);
      const gitFile = path.join(gitDir, 'config');
      await fs.writeFile(gitFile, 'git config');

      const app = await buildApp();
      const res = await app.request(`/api/files/raw?scope=fs&path=${encodeURIComponent(gitFile)}`);
      expect(res.status).toBe(403);
    });

    it('rejects relative paths for fs scope', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/raw?scope=fs&path=relative/path.txt');
      expect(res.status).toBe(400);
    });
  });
});
