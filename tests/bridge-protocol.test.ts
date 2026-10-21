import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

/**
 * Offline bridge-protocol regression test.
 *
 * Runs the real server with NO Gemini API key so every `start` is rejected
 * before any outbound connection. This verifies the transport contract,
 * session isolation and the "failed init must not report ready" behaviour
 * without spending quota or requiring credentials.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3199;
const HTTP_BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/live-ws`;

let serverProcess: ChildProcess | null = null;
const sockets: WebSocket[] = [];

async function waitForServer(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${HTTP_BASE}/api/status`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Bridge server did not start in time');
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    sockets.push(ws);
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

function nextMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 3000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for expected frame'));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });
}

/** Collects every frame for `ms` so we can assert that nothing was sent. */
function collectMessages(ws: WebSocket, ms = 600): Promise<any[]> {
  return new Promise((resolve) => {
    const collected: any[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        collected.push(JSON.parse(raw.toString()));
      } catch {
        /* ignore non-JSON */
      }
    };
    ws.on('message', onMessage);
    setTimeout(() => {
      ws.off('message', onMessage);
      resolve(collected);
    }, ms);
  });
}

before(async () => {
  serverProcess = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      GEMINI_API_KEY: '',
      DISABLE_HMR: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stderr?.on('data', () => {
    /* Vite warnings are irrelevant to the protocol assertions */
  });
  await waitForServer();
});

after(() => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  serverProcess?.kill('SIGTERM');
});

test('status endpoint reports the resolved model and whether a server key exists', async () => {
  const res = await fetch(`${HTTP_BASE}/api/status`);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.hasServerKey, false);
  assert.equal(data.targetModel, 'gemini-3.8-live');
  assert.equal(data.quotaStatus, 'Remaining account quota is not exposed by this session API.');
});

test('ping/pong round trip keeps working with no session attached', async () => {
  const ws = await openSocket();
  ws.send(JSON.stringify({ type: 'ping', clientMono: 1234 }));
  const pong = await nextMessage(ws, (m) => m.type === 'pong');
  assert.equal(pong.clientMono, 1234);
  assert.equal(typeof pong.serverMono, 'number');
  assert.match(pong.serverUtc, /^\d{4}-\d{2}-\d{2}T/);
});

test('start without a key fails closed: API_KEY_MISSING, no session_ready', async () => {
  const ws = await openSocket();
  const framesPromise = collectMessages(ws, 700);
  ws.send(JSON.stringify({ type: 'start', model: 'gemini-3.8-live' }));
  const frames = await framesPromise;

  const error = frames.find((f) => f.type === 'error');
  assert.ok(error, 'expected an error frame');
  assert.equal(error.code, 'API_KEY_MISSING');
  assert.match(error.sessionId, /^sess_/);
  assert.equal(
    frames.some((f) => f.type === 'session_ready' || f.type === 'ws_established'),
    false,
    'a rejected session must never report itself as ready'
  );
});

test('start with an unsupported model is rejected instead of substituted', async () => {
  const ws = await openSocket();
  ws.send(
    JSON.stringify({ type: 'start', model: 'gemini-2.0-flash-live', apiKey: 'fake-key' })
  );
  const error = await nextMessage(ws, (m) => m.type === 'error');
  assert.equal(error.code, 'INVALID_MODEL');
  assert.match(error.error, /gemini-3\.8-live/);
  assert.match(error.sessionId, /^sess_/);
});

test('concurrent client sockets receive distinct, isolated session IDs', async () => {
  const [wsA, wsB] = await Promise.all([openSocket(), openSocket()]);

  wsA.send(JSON.stringify({ type: 'start', model: 'gemini-3.8-live' }));
  wsB.send(JSON.stringify({ type: 'start', model: 'gemini-3.8-live' }));

  const [errorA, errorB] = await Promise.all([
    nextMessage(wsA, (m) => m.type === 'error'),
    nextMessage(wsB, (m) => m.type === 'error'),
  ]);

  assert.equal(errorA.code, 'API_KEY_MISSING');
  assert.equal(errorB.code, 'API_KEY_MISSING');
  assert.notEqual(errorA.sessionId, errorB.sessionId);

  // Both sockets remain usable after the failed start (no half-open state).
  wsA.send(JSON.stringify({ type: 'ping', clientMono: 11 }));
  wsB.send(JSON.stringify({ type: 'ping', clientMono: 22 }));
  const [pongA, pongB] = await Promise.all([
    nextMessage(wsA, (m) => m.type === 'pong'),
    nextMessage(wsB, (m) => m.type === 'pong'),
  ]);
  assert.equal(pongA.clientMono, 11);
  assert.equal(pongB.clientMono, 22);
});

test('end without a live session is harmless and the socket stays usable', async () => {
  const ws = await openSocket();
  ws.send(JSON.stringify({ type: 'end' }));
  // No response is required for an unknown session; the server must not crash.
  ws.send(JSON.stringify({ type: 'ping', clientMono: 99 }));
  const pong = await nextMessage(ws, (m) => m.type === 'pong');
  assert.equal(pong.clientMono, 99);
});

