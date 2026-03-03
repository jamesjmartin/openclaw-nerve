/** Tests for the file browser routes (tree, read, write, raw). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('file-browser routes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fbrowser-test-'));
    // Create a MEMORY.md in the tmpDir so getWorkspaceRoot returns tmpDir
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), '# Memories\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
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

  describe('GET /api/files/tree', () => {
    it('lists directory entries at root', async () => {
      await fs.writeFile(path.join(tmpDir, 'test.md'), '# Test');
      await fs.mkdir(path.join(tmpDir, 'subdir'));

      const app = await buildApp();
      const res = await app.request('/api/files/tree');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; entries: Array<{ name: string; type: string }> };
      expect(json.ok).toBe(true);
      expect(json.entries.length).toBeGreaterThanOrEqual(1);

      const names = json.entries.map(e => e.name);
      expect(names).toContain('test.md');
      expect(names).toContain('subdir');
    });

    it('returns 400 for non-existent subdirectory', async () => {
      // resolveWorkspacePath returns null for non-existent paths, so route returns 400
      const app = await buildApp();
      const res = await app.request('/api/files/tree?path=nonexistent');
      expect(res.status).toBe(400);
    });

    it('rejects path traversal attempts', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/tree?path=../../etc');
      expect(res.status).toBe(400);
    });

    it('excludes node_modules and .git', async () => {
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await fs.mkdir(path.join(tmpDir, '.git'));
      await fs.writeFile(path.join(tmpDir, 'visible.md'), 'hi');

      const app = await buildApp();
      const res = await app.request('/api/files/tree');
      const json = (await res.json()) as { ok: boolean; entries: Array<{ name: string }> };
      const names = json.entries.map(e => e.name);
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('.git');
    });
  });

  describe('GET /api/files/read', () => {
    it('returns 400 when path is missing', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/read');
      expect(res.status).toBe(400);
    });

    it('reads a text file', async () => {
      await fs.writeFile(path.join(tmpDir, 'readme.md'), '# Hello World');
      const app = await buildApp();
      const res = await app.request('/api/files/read?path=readme.md');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; content: string };
      expect(json.ok).toBe(true);
      expect(json.content).toBe('# Hello World');
    });

    it('returns 403 for non-existent file (resolveWorkspacePath fails)', async () => {
      // resolveWorkspacePath returns null for non-existent files (unless allowNonExistent)
      // so the route returns 403 "Invalid or excluded path", not 404
      const app = await buildApp();
      const res = await app.request('/api/files/read?path=nope.md');
      expect(res.status).toBe(403);
    });

    it('returns 415 for binary files', async () => {
      await fs.writeFile(path.join(tmpDir, 'image.png'), Buffer.from([0x89, 0x50]));
      const app = await buildApp();
      const res = await app.request('/api/files/read?path=image.png');
      expect(res.status).toBe(415);
    });

    it('rejects path traversal', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/read?path=../../../etc/passwd');
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/files/write', () => {
    it('writes a new file', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'new-file.md', content: '# New File' }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; mtime: number };
      expect(json.ok).toBe(true);
      expect(json.mtime).toBeGreaterThan(0);

      // Verify file was written
      const content = await fs.readFile(path.join(tmpDir, 'new-file.md'), 'utf-8');
      expect(content).toBe('# New File');
    });

    it('returns 400 when path is missing', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when content is missing', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'test.md' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects path traversal on write', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '../../etc/passwd', content: 'hacked' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects binary file writes', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'image.png', content: 'not really an image' }),
      });
      expect(res.status).toBe(415);
    });

    it('detects conflict via expectedMtime', async () => {
      const filePath = path.join(tmpDir, 'conflict.md');
      await fs.writeFile(filePath, 'original');

      const app = await buildApp();
      // Write with a stale mtime
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'conflict.md', content: 'updated', mtime: 1 }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/files/rename', () => {
    it('renames a file in place', async () => {
      await fs.writeFile(path.join(tmpDir, 'old.md'), 'hello');
      const app = await buildApp();

      const res = await app.request('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'old.md', newName: 'new.md' }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; from: string; to: string };
      expect(json.ok).toBe(true);
      expect(json.from).toBe('old.md');
      expect(json.to).toBe('new.md');

      await expect(fs.readFile(path.join(tmpDir, 'new.md'), 'utf-8')).resolves.toBe('hello');
    });

    it('returns 409 on name conflict', async () => {
      await fs.writeFile(path.join(tmpDir, 'a.md'), 'a');
      await fs.writeFile(path.join(tmpDir, 'b.md'), 'b');
      const app = await buildApp();

      const res = await app.request('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'a.md', newName: 'b.md' }),
      });

      expect(res.status).toBe(409);
    });

    it('blocks renaming a root file to reserved .trash', async () => {
      await fs.writeFile(path.join(tmpDir, 'note.md'), 'x');
      const app = await buildApp();

      const res = await app.request('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'note.md', newName: '.trash' }),
      });

      expect(res.status).toBe(422);
    });

    it('rejects rename with control characters in name', async () => {
      await fs.writeFile(path.join(tmpDir, 'note.md'), 'x');
      const app = await buildApp();

      const res = await app.request('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'note.md', newName: 'bad\u0000name.md' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/files/move', () => {
    it('moves a file into a directory', async () => {
      await fs.mkdir(path.join(tmpDir, 'docs'));
      await fs.writeFile(path.join(tmpDir, 'note.md'), 'hello');
      const app = await buildApp();

      const res = await app.request('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: 'note.md', targetDirPath: 'docs' }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; from: string; to: string };
      expect(json.ok).toBe(true);
      expect(json.to).toBe('docs/note.md');

      await expect(fs.readFile(path.join(tmpDir, 'docs', 'note.md'), 'utf-8')).resolves.toBe('hello');
    });

    it('blocks moving a folder into its own descendant', async () => {
      await fs.mkdir(path.join(tmpDir, 'a'));
      await fs.mkdir(path.join(tmpDir, 'a', 'b'), { recursive: true });
      const app = await buildApp();

      const res = await app.request('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: 'a', targetDirPath: 'a/b' }),
      });

      expect(res.status).toBe(422);
    });

    it('blocks moving directly into .trash via generic move API', async () => {
      await fs.mkdir(path.join(tmpDir, '.trash'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'note.md'), 'x');
      const app = await buildApp();

      const res = await app.request('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: 'note.md', targetDirPath: '.trash' }),
      });

      expect(res.status).toBe(422);
      const json = (await res.json()) as { code?: string };
      expect(json.code).toBe('use_trash_api');
    });
  });

  describe('POST /api/files/trash + /api/files/restore', () => {
    it('moves file to .trash and restores it back', async () => {
      await fs.mkdir(path.join(tmpDir, 'docs'));
      await fs.writeFile(path.join(tmpDir, 'docs', 'spec.md'), 'spec');
      const app = await buildApp();

      const trashRes = await app.request('/api/files/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'docs/spec.md' }),
      });

      expect(trashRes.status).toBe(200);
      const trashJson = (await trashRes.json()) as { ok: boolean; from: string; to: string };
      expect(trashJson.ok).toBe(true);
      expect(trashJson.from).toBe('docs/spec.md');
      expect(trashJson.to.startsWith('.trash/')).toBe(true);

      // .trash should be visible, but internal index should remain hidden
      const treeRes = await app.request('/api/files/tree?path=.trash&depth=1');
      expect(treeRes.status).toBe(200);
      const treeJson = (await treeRes.json()) as { ok: boolean; entries: Array<{ name: string }> };
      const names = treeJson.entries.map((e) => e.name);
      expect(names).not.toContain('.index.json');

      const restoreRes = await app.request('/api/files/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trashJson.to }),
      });

      expect(restoreRes.status).toBe(200);
      const restoreJson = (await restoreRes.json()) as { ok: boolean; to: string };
      expect(restoreJson.ok).toBe(true);
      expect(restoreJson.to).toBe('docs/spec.md');

      await expect(fs.readFile(path.join(tmpDir, 'docs', 'spec.md'), 'utf-8')).resolves.toBe('spec');
    });

    it('restore returns 409 when original path is occupied', async () => {
      await fs.mkdir(path.join(tmpDir, 'docs'));
      await fs.writeFile(path.join(tmpDir, 'docs', 'spec.md'), 'original');
      const app = await buildApp();

      const trashRes = await app.request('/api/files/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'docs/spec.md' }),
      });
      const trashJson = (await trashRes.json()) as { to: string };

      // Re-create original path to force conflict
      await fs.writeFile(path.join(tmpDir, 'docs', 'spec.md'), 'replacement');

      const restoreRes = await app.request('/api/files/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trashJson.to }),
      });

      expect(restoreRes.status).toBe(409);
    });
  });

  describe('GET /api/files/raw', () => {
    it('returns 400 when path is missing', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/raw');
      expect(res.status).toBe(400);
    });

    it('returns 415 for unsupported file types', async () => {
      await fs.writeFile(path.join(tmpDir, 'file.txt'), 'hello');
      const app = await buildApp();
      const res = await app.request('/api/files/raw?path=file.txt');
      expect(res.status).toBe(415);
    });

    it('serves image files with correct MIME type', async () => {
      await fs.writeFile(path.join(tmpDir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const app = await buildApp();
      const res = await app.request('/api/files/raw?path=photo.png');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
    });
  });

  describe('GET /api/files/workspace-info', () => {
    it('returns workspace information with default workspace', async () => {
      const app = await buildApp();
      const res = await app.request('/api/files/workspace-info');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; isCustomWorkspace: boolean; workspaces: Array<{ index: number; root: string; name: string }> };
      expect(json.ok).toBe(true);
      expect(json.isCustomWorkspace).toBe(false);
      expect(json.workspaces).toHaveLength(1);
      expect(json.workspaces[0].index).toBe(0);
      expect(json.workspaces[0].root).toBe(tmpDir);
    });

    it('returns multiple workspaces when configured', async () => {
      vi.resetModules();
      const workspace1 = await fs.mkdtemp(path.join(os.tmpdir(), 'ws1-'));
      const workspace2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ws2-'));

      vi.doMock('../lib/config.js', () => ({
        config: {
          auth: false, port: 3000, host: '127.0.0.1', sslPort: 3443,
          memoryPath: path.join(workspace1, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
        SESSION_COOKIE_NAME: 'nerve_session_3000',
      }));

      const mod = await import('./file-browser.js');
      const app = new Hono();
      app.route('/', mod.default);

      const res = await app.request('/api/files/workspace-info');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; isCustomWorkspace: boolean; workspaces: Array<{ index: number; root: string; name: string }> };
      expect(json.ok).toBe(true);
      expect(json.isCustomWorkspace).toBe(true);
      expect(json.workspaces).toHaveLength(2);
      expect(json.workspaces[0].root).toBe(workspace1);
      expect(json.workspaces[1].root).toBe(workspace2);

      await fs.rm(workspace1, { recursive: true, force: true });
      await fs.rm(workspace2, { recursive: true, force: true });
    });
  });

  describe('workspace index parameter', () => {
    it('GET /api/files/tree accepts workspace query parameter', async () => {
      vi.resetModules();
      const workspace1 = await fs.mkdtemp(path.join(os.tmpdir(), 'ws1-'));
      const workspace2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ws2-'));
      
      await fs.writeFile(path.join(workspace1, 'MEMORY.md'), '# Workspace 1');
      await fs.writeFile(path.join(workspace1, 'file1.md'), 'content1');
      await fs.writeFile(path.join(workspace2, 'file2.md'), 'content2');

      vi.doMock('../lib/config.js', () => ({
        config: {
          auth: false, port: 3000, host: '127.0.0.1', sslPort: 3443,
          memoryPath: path.join(workspace1, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
        SESSION_COOKIE_NAME: 'nerve_session_3000',
      }));

      const mod = await import('./file-browser.js');
      const app = new Hono();
      app.route('/', mod.default);

      // Test workspace 0
      const res0 = await app.request('/api/files/tree?workspace=0');
      expect(res0.status).toBe(200);
      const json0 = (await res0.json()) as { ok: boolean; entries: Array<{ name: string }> };
      const names0 = json0.entries.map(e => e.name);
      expect(names0).toContain('file1.md');
      expect(names0).not.toContain('file2.md');

      // Test workspace 1
      const res1 = await app.request('/api/files/tree?workspace=1');
      expect(res1.status).toBe(200);
      const json1 = (await res1.json()) as { ok: boolean; entries: Array<{ name: string }> };
      const names1 = json1.entries.map(e => e.name);
      expect(names1).toContain('file2.md');
      expect(names1).not.toContain('file1.md');

      await fs.rm(workspace1, { recursive: true, force: true });
      await fs.rm(workspace2, { recursive: true, force: true });
    });

    it('GET /api/files/read accepts workspace query parameter', async () => {
      vi.resetModules();
      const workspace1 = await fs.mkdtemp(path.join(os.tmpdir(), 'ws1-'));
      const workspace2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ws2-'));
      
      await fs.writeFile(path.join(workspace1, 'MEMORY.md'), '# Workspace 1');
      await fs.writeFile(path.join(workspace1, 'test.md'), 'workspace 1 content');
      await fs.writeFile(path.join(workspace2, 'test.md'), 'workspace 2 content');

      vi.doMock('../lib/config.js', () => ({
        config: {
          auth: false, port: 3000, host: '127.0.0.1', sslPort: 3443,
          memoryPath: path.join(workspace1, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
        SESSION_COOKIE_NAME: 'nerve_session_3000',
      }));

      const mod = await import('./file-browser.js');
      const app = new Hono();
      app.route('/', mod.default);

      // Read from workspace 0
      const res0 = await app.request('/api/files/read?path=test.md&workspace=0');
      expect(res0.status).toBe(200);
      const json0 = (await res0.json()) as { ok: boolean; content: string };
      expect(json0.content).toBe('workspace 1 content');

      // Read from workspace 1
      const res1 = await app.request('/api/files/read?path=test.md&workspace=1');
      expect(res1.status).toBe(200);
      const json1 = (await res1.json()) as { ok: boolean; content: string };
      expect(json1.content).toBe('workspace 2 content');

      await fs.rm(workspace1, { recursive: true, force: true });
      await fs.rm(workspace2, { recursive: true, force: true });
    });

    it('PUT /api/files/write accepts workspaceIndex in body', async () => {
      vi.resetModules();
      const workspace1 = await fs.mkdtemp(path.join(os.tmpdir(), 'ws1-'));
      const workspace2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ws2-'));
      
      await fs.writeFile(path.join(workspace1, 'MEMORY.md'), '# Workspace 1');

      vi.doMock('../lib/config.js', () => ({
        config: {
          auth: false, port: 3000, host: '127.0.0.1', sslPort: 3443,
          memoryPath: path.join(workspace1, 'MEMORY.md'),
          fileBrowserPaths: `${workspace1},${workspace2}`,
        },
        SESSION_COOKIE_NAME: 'nerve_session_3000',
      }));

      const mod = await import('./file-browser.js');
      const app = new Hono();
      app.route('/', mod.default);

      // Write to workspace 1
      const res = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'new.md', content: 'test content', workspaceIndex: 1 }),
      });

      expect(res.status).toBe(200);
      
      // Verify file was written to workspace 1, not workspace 0
      await expect(fs.readFile(path.join(workspace2, 'new.md'), 'utf-8')).resolves.toBe('test content');
      await expect(fs.access(path.join(workspace1, 'new.md'))).rejects.toThrow();

      await fs.rm(workspace1, { recursive: true, force: true });
      await fs.rm(workspace2, { recursive: true, force: true });
    });
  });

  describe('POST /api/files/trash with custom workspace', () => {
    it('permanently deletes files in custom workspace', async () => {
      vi.resetModules();
      const customWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-'));
      await fs.writeFile(path.join(customWorkspace, 'MEMORY.md'), '# Custom');
      await fs.writeFile(path.join(customWorkspace, 'delete-me.md'), 'content');

      vi.doMock('../lib/config.js', () => ({
        config: {
          auth: false, port: 3000, host: '127.0.0.1', sslPort: 3443,
          memoryPath: path.join(customWorkspace, 'MEMORY.md'),
          fileBrowserPaths: customWorkspace,
        },
        SESSION_COOKIE_NAME: 'nerve_session_3000',
      }));

      const mod = await import('./file-browser.js');
      const app = new Hono();
      app.route('/', mod.default);

      const res = await app.request('/api/files/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'delete-me.md' }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; from: string; to: string };
      expect(json.ok).toBe(true);
      expect(json.to).toBe(''); // Empty 'to' indicates permanent delete

      // Verify file is gone
      await expect(fs.access(path.join(customWorkspace, 'delete-me.md'))).rejects.toThrow();
      
      // Verify no .trash directory was created
      await expect(fs.access(path.join(customWorkspace, '.trash'))).rejects.toThrow();

      await fs.rm(customWorkspace, { recursive: true, force: true });
    });

    it('uses trash for default workspace', async () => {
      await fs.writeFile(path.join(tmpDir, 'trash-me.md'), 'content');
      const app = await buildApp();

      const res = await app.request('/api/files/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'trash-me.md' }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; from: string; to: string };
      expect(json.ok).toBe(true);
      expect(json.to.startsWith('.trash/')).toBe(true); // Non-empty 'to' indicates trash

      // Verify file is in trash
      const trashPath = path.join(tmpDir, json.to);
      await expect(fs.access(trashPath)).resolves.toBeUndefined();
    });
  });

  describe('Regression Tests - Backward Compatibility', () => {
    it('maintains existing behavior when no workspace env var', async () => {
      const app = await buildApp();
      
      // Should use default workspace (tmpDir)
      const res = await app.request('/api/files/workspace-info');
      const json = (await res.json()) as { ok: boolean; isCustomWorkspace: boolean; workspaces: Array<{ index: number; root: string }> };
      expect(json.isCustomWorkspace).toBe(false);
      expect(json.workspaces).toHaveLength(1);
      expect(json.workspaces[0].root).toBe(tmpDir);
    });

    it('endpoints work without workspace parameters', async () => {
      await fs.writeFile(path.join(tmpDir, 'test.md'), 'content');
      const app = await buildApp();

      // GET /api/files/tree without workspace query
      const treeRes = await app.request('/api/files/tree');
      expect(treeRes.status).toBe(200);
      const treeJson = (await treeRes.json()) as { ok: boolean; entries: Array<{ name: string }> };
      expect(treeJson.entries.map(e => e.name)).toContain('test.md');

      // GET /api/files/read without workspace query
      const readRes = await app.request('/api/files/read?path=test.md');
      expect(readRes.status).toBe(200);
      const readJson = (await readRes.json()) as { ok: boolean; content: string };
      expect(readJson.content).toBe('content');

      // PUT /api/files/write without workspaceIndex
      const writeRes = await app.request('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'new.md', content: 'new content' }),
      });
      expect(writeRes.status).toBe(200);
      await expect(fs.access(path.join(tmpDir, 'new.md'))).resolves.toBeUndefined();
    });

    it('trash system unchanged for default workspace', async () => {
      await fs.writeFile(path.join(tmpDir, 'trash-test.md'), 'content');
      const app = await buildApp();

      // Trash the file
      const trashRes = await app.request('/api/files/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'trash-test.md' }),
      });
      expect(trashRes.status).toBe(200);
      const trashJson = (await trashRes.json()) as { ok: boolean; from: string; to: string; undoTtlMs: number };
      expect(trashJson.to.startsWith('.trash/')).toBe(true);
      expect(trashJson.undoTtlMs).toBeGreaterThan(0);

      // Verify .trash directory and index exist
      await expect(fs.access(path.join(tmpDir, '.trash'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(tmpDir, '.trash', '.index.json'))).resolves.toBeUndefined();

      // Restore the file
      const restoreRes = await app.request('/api/files/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trashJson.to }),
      });
      expect(restoreRes.status).toBe(200);
      await expect(fs.access(path.join(tmpDir, 'trash-test.md'))).resolves.toBeUndefined();
    });

    it('move and rename operations unchanged', async () => {
      await fs.writeFile(path.join(tmpDir, 'old.md'), 'content');
      await fs.mkdir(path.join(tmpDir, 'docs'));
      const app = await buildApp();

      // Rename operation
      const renameRes = await app.request('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'old.md', newName: 'renamed.md' }),
      });
      expect(renameRes.status).toBe(200);
      await expect(fs.access(path.join(tmpDir, 'old.md'))).rejects.toThrow();
      await expect(fs.access(path.join(tmpDir, 'renamed.md'))).resolves.toBeUndefined();

      // Move operation
      const moveRes = await app.request('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: 'renamed.md', targetDirPath: 'docs' }),
      });
      expect(moveRes.status).toBe(200);
      await expect(fs.access(path.join(tmpDir, 'docs', 'renamed.md'))).resolves.toBeUndefined();
    });
  });
});
