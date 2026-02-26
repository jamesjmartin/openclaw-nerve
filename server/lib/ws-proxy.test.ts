/** Tests for ws-proxy — connection, relaying, auth, and lifecycle. */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { MockGateway } from '../../src/test/mock-gateway.js';

// Mock config before importing ws-proxy
vi.mock('./config.js', () => {
  const WS_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  return {
    config: {
      auth: false,
      sessionSecret: 'test-secret',
      gatewayToken: 'test-token',
    },
    WS_ALLOWED_HOSTS,
    SESSION_COOKIE_NAME: 'nerve_session_3080',
  };
});

vi.mock('./session.js', () => ({
  verifySession: vi.fn(),
  parseSessionCookie: vi.fn(),
}));

vi.mock('./device-identity.js', () => ({
  getDeviceIdentity: vi.fn(() => ({
    deviceId: 'mock-device-id-' + '0'.repeat(48),
    publicKeyRaw: Buffer.alloc(32),
    publicKeyB64url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    privateKeyPem: '',
  })),
  createDeviceBlock: vi.fn(() => ({
    id: 'mock-device-id-' + '0'.repeat(48),
    publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    signature: 'mock-signature',
    signedAt: Date.now(),
    nonce: 'test-nonce',
  })),
}));

vi.mock('./openclaw-bin.js', () => ({
  resolveOpenclawBin: vi.fn(() => '/usr/bin/echo'),
}));

import { setupWebSocketProxy, closeAllWebSockets } from './ws-proxy.js';
import { config } from './config.js';
import { verifySession, parseSessionCookie } from './session.js';

const mockedConfig = config as { auth: boolean; sessionSecret: string };
const mockedVerifySession = verifySession as ReturnType<typeof vi.fn>;
const mockedParseSessionCookie = parseSessionCookie as ReturnType<typeof vi.fn>;

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Wait for close or error — useful when server rejects the upgrade entirely */
function waitForCloseOrError(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close/error timeout')), timeoutMs);
    const done = (code: number, reason: string) => {
      clearTimeout(timer);
      resolve({ code, reason });
    };
    ws.once('close', (code, reason) => done(code, reason.toString()));
    ws.once('error', (err) => {
      // ws library throws errors for HTTP rejection or socket destruction
      done(1006, err.message);
    });
  });
}

describe('ws-proxy', () => {
  let mockGw: MockGateway;
  let proxyServer: Server;
  let proxyPort: number;

  beforeAll(async () => {
    mockGw = new MockGateway();
    await mockGw.start();
  });

  afterAll(async () => {
    closeAllWebSockets();
    await mockGw.close();
  });

  beforeEach(async () => {
    mockedConfig.auth = false;
    mockedVerifySession.mockReset();
    mockedParseSessionCookie.mockReset();
    mockGw.clearReceived();

    // Create a new HTTP server and attach ws-proxy
    proxyServer = createServer();
    setupWebSocketProxy(proxyServer);

    await new Promise<void>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = proxyServer.address();
    proxyPort = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    closeAllWebSockets();
    await new Promise<void>((resolve) => {
      proxyServer.close(() => resolve());
    });
  });

  describe('connection establishment', () => {
    it('rejects connections without ?target param', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(1008);
      expect(reason).toContain('Missing');
    });

    it('rejects connections with invalid target URL', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=not-a-url`);
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });

    it('rejects connections with disallowed host', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=ws://evil.com:9999`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(1008);
      expect(reason).toContain('not allowed');
    });

    it('allows root path for gateway target', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url)}`,
      );
      const msg = await waitForMessage(ws);
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('event');
      expect(parsed.event).toBe('connect.challenge');
      ws.close();
    });

    it('accepts connections to allowed gateway target', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      // Should receive connect.challenge from mock gateway (relayed through proxy)
      const msg = await waitForMessage(ws);
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('event');
      expect(parsed.event).toBe('connect.challenge');
      expect(parsed.payload.nonce).toBeTruthy();
      ws.close();
    });

    it('destroys non-/ws upgrade requests', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/other`);
      const { code } = await waitForCloseOrError(ws);
      // Socket gets destroyed = abnormal close
      expect(code).toBe(1006);
    });
  });

  describe('message relaying', () => {
    it('relays gateway messages to client', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      // First message is the connect.challenge
      const challenge = await waitForMessage(ws);
      expect(JSON.parse(challenge).event).toBe('connect.challenge');

      // Gateway broadcasts a custom event
      mockGw.broadcast(JSON.stringify({ type: 'event', event: 'test', payload: { hello: true } }));

      const msg = await waitForMessage(ws);
      const parsed = JSON.parse(msg);
      expect(parsed.type).toBe('event');
      expect(parsed.event).toBe('test');
      expect(parsed.payload.hello).toBe(true);

      ws.close();
    });

    it('relays client messages to gateway', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      await waitForMessage(ws); // consume challenge

      // Send a message from client through proxy
      ws.send(JSON.stringify({ type: 'req', method: 'ping', id: 'p1' }));

      // Wait for it to arrive at the mock gateway
      const msgs = await mockGw.expectMessages(1, 2000);
      const received = msgs[0].data as Record<string, unknown>;
      expect(received.type).toBe('req');
      expect(received.method).toBe('ping');

      ws.close();
    });
  });

  describe('auth enforcement', () => {
    it('rejects WS upgrade when auth is enabled and no cookie', async () => {
      mockedConfig.auth = true;
      mockedParseSessionCookie.mockReturnValue(null);

      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`);
      const { code } = await waitForCloseOrError(ws);
      // Should get rejected (socket destroyed = 1006 or HTTP 401)
      expect(code).toBe(1006);
    });

    it('rejects WS upgrade when auth is enabled and session is invalid', async () => {
      mockedConfig.auth = true;
      mockedParseSessionCookie.mockReturnValue('bad-token');
      mockedVerifySession.mockReturnValue(null);

      const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`);
      const { code } = await waitForCloseOrError(ws);
      expect(code).toBe(1006);
    });

    it('allows WS upgrade when auth is enabled and session is valid', async () => {
      mockedConfig.auth = true;
      mockedParseSessionCookie.mockReturnValue('good-token');
      mockedVerifySession.mockReturnValue({ exp: Date.now() + 60000, iat: Date.now() });

      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
        { headers: { Cookie: 'nerve_session_3080=good-token' } },
      );
      const msg = await waitForMessage(ws);
      expect(JSON.parse(msg).event).toBe('connect.challenge');
      ws.close();
    });
  });

  describe('closeAllWebSockets', () => {
    it('closes all active connections', async () => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${proxyPort}/ws?target=${encodeURIComponent(mockGw.url + '/ws')}`,
      );
      await waitForMessage(ws); // Wait for challenge = connection established

      const closePromise = waitForClose(ws);
      closeAllWebSockets();
      const { code } = await closePromise;
      expect(code).toBe(1001); // Server shutting down
    });
  });
});
