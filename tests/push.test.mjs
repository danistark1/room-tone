import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fakeSubscription = suffix => ({
  endpoint: `https://web.push.apple.com/roomtone-test-${suffix}`,
  keys: { p256dh: Buffer.alloc(65, 3).toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url') },
});

test('push-only rooms can be called and the first reopened device wins', async () => {
  const port = 34000 + Math.floor(Math.random() * 20000);
  const origin = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'roomtone-push-'));
  const logPath = join(dir, 'push-deliveries.jsonl');
  const sockets = [];
  let server;
  let cookie = '';
  const start = () => spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PIN: 'push-test-pin',
      NODE_ENV: 'test', PUSH_TEST_LOG: logPath, CALL_SETUP_TIMEOUT_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  async function readyServer() {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(origin + '/healthz')).ok) return; } catch {}
      await sleep(100);
    }
    throw new Error('Server did not start.');
  }
  async function api(path, method = 'GET', body, auth = false) {
    const response = await fetch(origin + path, { method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: response.status === 204 ? null : await response.json(), headers: response.headers };
  }
  function connect(profile) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { Origin: origin } });
    sockets.push(socket);
    const messages = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    return { socket, messages,
      async ready() {
        if (socket.readyState !== WebSocket.OPEN) await new Promise(resolve => socket.once('open', resolve));
        socket.send(JSON.stringify({ type: 'hello', deviceId: profile.device.id, token: profile.token }));
        return this.wait(item => item.type === 'ready');
      },
      send(message) { socket.send(JSON.stringify(message)); },
      async wait(predicate, timeout = 4000) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
          const found = messages.find(predicate);
          if (found) return found;
          await sleep(20);
        }
        throw new Error(`Timed out waiting for message: ${JSON.stringify(messages)}`);
      },
    };
  }
  try {
    server = start(); await readyServer();
    const firstKey = (await api('/api/push/config')).data.publicKey;
    assert.match(firstKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(JSON.stringify((await api('/api/push/config')).data).includes('privateKey'), false);
    const [from, to] = (await api('/api/bootstrap')).data.rooms;
    const login = await api('/api/admin/login', 'POST', { pin: 'push-test-pin' });
    cookie = login.headers.get('set-cookie').split(';')[0];
    const caller = (await api('/api/device', 'POST', { name: 'Caller', roomId: from.id }, true)).data;
    const receiverA = (await api('/api/device', 'POST', { name: 'Receiver A', roomId: to.id }, true)).data;
    const receiverB = (await api('/api/device', 'POST', { name: 'Receiver B', roomId: to.id }, true)).data;
    const payloadA = { id: receiverA.device.id, token: receiverA.token, subscription: fakeSubscription('a') };
    const payloadB = { id: receiverB.device.id, token: receiverB.token, subscription: fakeSubscription('b') };
    assert.equal((await api('/api/push/subscription', 'POST', { ...payloadA, token: 'wrong' })).status, 401);
    assert.equal((await api('/api/push/subscription', 'POST', { ...payloadA, subscription: { ...fakeSubscription('a'), endpoint: 'http://127.0.0.1:3000/' } })).status, 400);
    assert.equal((await api('/api/push/subscription', 'POST', { ...payloadA, subscription: { ...fakeSubscription('a'), endpoint: 'https://web.push.apple.com.evil.test/' } })).status, 400);
    assert.equal((await api('/api/push/subscription', 'POST', payloadA)).status, 200);
    assert.equal((await api('/api/push/subscription', 'POST', payloadB)).status, 200);
    const offlinePresence = (await api('/api/bootstrap')).data.presence.find(item => item.roomId === to.id);
    assert.equal(offlinePresence.online, 0);
    assert.equal(offlinePresence.alerts, 2);
    assert.equal((await api(`/api/devices/${receiverA.device.id}/test-alert`, 'POST')).status, 401);
    const testAlert = await api(`/api/devices/${receiverA.device.id}/test-alert`, 'POST', undefined, true);
    assert.equal(testAlert.status, 200);
    assert.equal(testAlert.data.providerStatus, 201);
    assert.equal((await api(`/api/devices/${receiverA.device.id}/test-alert`, 'POST', undefined, true)).status, 429);
    const testDelivery = JSON.parse(readFileSync(logPath, 'utf8').trim());
    assert.equal(testDelivery.payload.type, 'test');
    assert.equal(testDelivery.ttl, 60);
    const callerSocket = connect(caller); await callerSocket.ready();
    callerSocket.send({ type: 'call:start', targetRoomId: to.id, mode: 'audio' });
    const outgoing = await callerSocket.wait(item => item.type === 'call:outgoing');
    let deliveries = [];
    for (let i = 0; i < 100; i++) {
      deliveries = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.payload.type === 'call') : [];
      if (deliveries.length === 2) break;
      await sleep(20);
    }
    assert.equal(deliveries.length, 2);
    assert.deepEqual(deliveries.map(item => item.endpoint).sort(), [payloadA.subscription.endpoint, payloadB.subscription.endpoint].sort());
    assert.ok(deliveries.every(item => item.payload.callId === outgoing.callId && item.ttl === 75));
    assert.ok(deliveries.every(item => !JSON.stringify(item.payload).includes('Living room')));
    const a = connect(receiverA), b = connect(receiverB);
    await a.ready(); await b.ready();
    assert.equal((await a.wait(item => item.type === 'call:ring')).callId, outgoing.callId);
    assert.equal((await b.wait(item => item.type === 'call:ring')).callId, outgoing.callId);
    b.send({ type: 'call:answer', callId: outgoing.callId });
    assert.equal((await callerSocket.wait(item => item.type === 'call:connected')).peerDevice, 'Receiver B');
    assert.equal((await a.wait(item => item.type === 'call:answered_elsewhere')).callId, outgoing.callId);
    b.send({ type: 'call:end', callId: outgoing.callId });
    await callerSocket.wait(item => item.type === 'call:ended' && item.callId === outgoing.callId);
    a.socket.close(); b.socket.close();
    await sleep(150);
    assert.equal((await api('/api/bootstrap')).data.presence.find(item => item.roomId === to.id).alerts, 2);
    assert.equal((await api('/api/devices', 'GET', undefined, true)).data.find(item => item.id === receiverA.device.id).alerts, true);
    assert.equal((await api('/api/push/subscription', 'DELETE', { id: receiverA.device.id, token: receiverA.token })).status, 204);
    assert.equal((await api(`/api/devices/${receiverA.device.id}/test-alert`, 'POST', undefined, true)).status, 409);
    callerSocket.send({ type: 'call:start', targetRoomId: to.id, mode: 'audio' });
    const resumedCall = await callerSocket.wait(item => item.type === 'call:outgoing' && item.callId !== outgoing.callId);
    const firstAttempt = connect(receiverB); await firstAttempt.ready();
    await firstAttempt.wait(item => item.type === 'call:ring' && item.callId === resumedCall.callId);
    firstAttempt.socket.close();
    await sleep(150);
    assert.equal((await api('/api/bootstrap')).data.presence.find(item => item.roomId === to.id).busy, true,
      'a subscribed phone must remain eligible after its WebSocket is suspended');
    const returned = connect(receiverB); await returned.ready();
    await returned.wait(item => item.type === 'call:ring' && item.callId === resumedCall.callId);
    returned.send({ type: 'call:answer', callId: resumedCall.callId });
    await callerSocket.wait(item => item.type === 'call:connected' && item.callId === resumedCall.callId);
    returned.send({ type: 'call:end', callId: resumedCall.callId });
    await callerSocket.wait(item => item.type === 'call:ended' && item.callId === resumedCall.callId);
    returned.socket.close();
    assert.equal((await api(`/api/devices/${receiverB.device.id}`, 'DELETE', undefined, true)).status, 204);
    assert.equal((await api('/api/bootstrap')).data.presence.find(item => item.roomId === to.id).alerts, 0);
    callerSocket.send({ type: 'call:start', targetRoomId: to.id, mode: 'audio' });
    assert.match((await callerSocket.wait(item => item.type === 'error' && /offline/.test(item.message))).message, /offline/);
    for (const item of sockets) item.close();
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
    server = start(); await readyServer();
    assert.equal((await api('/api/push/config')).data.publicKey, firstKey, 'VAPID keys survive an app restart');
  } finally {
    sockets.forEach(item => item.close());
    server?.kill('SIGTERM');
    if (server && server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
