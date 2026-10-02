import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const port = 32000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), 'roomtone-test-'));
let server;
let cookie = '';
const sockets = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, method = 'GET', body, auth = false) {
  const response = await fetch(origin + path, {
    method, headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json(), headers: response.headers };
}
function connect(device, options = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { Origin: origin }, ...options });
  sockets.push(socket);
  const messages = [];
  const pending = [];
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); messages.push(message);
    for (const item of [...pending]) {
      if (item.predicate(message)) { clearTimeout(item.timer); pending.splice(pending.indexOf(item), 1); item.resolve(message); }
    }
  });
  const wait = (predicate, timeout = 3000) => new Promise((resolve, reject) => {
    const found = messages.find(predicate);
    if (found) return resolve(found);
    const item = { predicate, resolve, timer: setTimeout(() => { pending.splice(pending.indexOf(item), 1); reject(new Error('Timed out waiting for message: ' + JSON.stringify(messages))); }, timeout) };
    pending.push(item);
  });
  return { socket, messages, wait, async ready() { if (socket.readyState !== WebSocket.OPEN) await new Promise(resolve => socket.once('open', resolve)); socket.send(JSON.stringify({ type: 'hello', deviceId: device.device.id, token: device.token })); return wait(message => message.type === 'ready'); },
    send(message) { socket.send(JSON.stringify(message)); } };
}

test('admin-only assignments and first-answer room calls', async () => {
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PIN: 'integration-secret', NODE_ENV: 'test', CALL_SETUP_TIMEOUT_MS: '1500', WS_HEARTBEAT_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { ready = (await api('/healthz')).status === 200; if (ready) break; } catch {}
      await sleep(100);
    }
    assert.ok(ready, 'server started');
    const bootstrap = await api('/api/bootstrap');
    assert.equal(bootstrap.data.rooms.length, 4);
    const [from, to] = bootstrap.data.rooms;
    const forbiddenRoom = await api('/api/rooms', 'POST', { name: 'Unauthorized' });
    assert.equal(forbiddenRoom.status, 401);
    const forbiddenAssignment = await api('/api/device', 'POST', { name: 'Not allowed', roomId: from.id });
    assert.equal(forbiddenAssignment.status, 401);
    assert.equal((await api('/api/device', 'POST', { name: 'Unassigned', roomId: null })).status, 401);
    const login = await api('/api/admin/login', 'POST', { pin: 'integration-secret' });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
    assert.ok(cookie.startsWith('rt_admin='));
    const caller = (await api('/api/device', 'POST', { name: 'Caller', roomId: from.id }, true)).data;
    const receiverA = (await api('/api/device', 'POST', { name: 'Receiver A', roomId: to.id }, true)).data;
    const receiverB = (await api('/api/device', 'POST', { name: 'Receiver B', roomId: to.id }, true)).data;
    const unauthorizedMove = await api('/api/device', 'POST', { ...caller.device, token: caller.token, name: 'Caller', roomId: to.id });
    assert.equal(unauthorizedMove.status, 401);
    const a = connect(caller), b = connect(receiverA), c = connect(receiverB);
    await a.ready(); await b.ready(); await c.ready();
    a.send({ type: 'call:start', targetRoomId: to.id, mode: 'video' });
    const outgoing = await a.wait(message => message.type === 'call:outgoing');
    const ringA = await b.wait(message => message.type === 'call:ring');
    const ringB = await c.wait(message => message.type === 'call:ring');
    assert.equal(ringA.callId, outgoing.callId);
    assert.equal(ringB.callId, outgoing.callId);
    b.send({ type: 'call:answer', callId: outgoing.callId });
    const connectedCaller = await a.wait(message => message.type === 'call:connected');
    const connectedReceiver = await b.wait(message => message.type === 'call:connected');
    await c.wait(message => message.type === 'call:answered_elsewhere');
    assert.equal(connectedCaller.peerDevice, 'Receiver A');
    assert.equal(connectedReceiver.role, 'callee');
    c.send({ type: 'call:answer', callId: outgoing.callId });
    a.send({ type: 'signal', callId: outgoing.callId, signal: { kind: 'offer', sdp: { type: 'offer', sdp: 'test-sdp' } } });
    assert.equal((await b.wait(message => message.type === 'signal')).signal.kind, 'offer');
    assert.equal(c.messages.filter(message => message.type === 'signal').length, 0);
    b.send({ type: 'call:end', callId: outgoing.callId });
    await a.wait(message => message.type === 'call:ended');
    a.send({ type: 'call:start', targetRoomId: to.id, mode: 'audio' });
    const second = await a.wait(message => message.type === 'call:outgoing' && message.callId !== outgoing.callId);
    await b.wait(message => message.type === 'call:ring' && message.callId === second.callId);
    await c.wait(message => message.type === 'call:ring' && message.callId === second.callId);
    b.send({ type: 'call:decline', callId: second.callId });
    c.send({ type: 'call:answer', callId: second.callId });
    assert.equal((await a.wait(message => message.type === 'call:connected' && message.callId === second.callId)).peerDevice, 'Receiver B');
    c.send({ type: 'call:end', callId: second.callId });
    await a.wait(message => message.type === 'call:ended' && message.callId === second.callId);
    const anonymous = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { Origin: origin } });
    sockets.push(anonymous);
    await new Promise(resolve => anonymous.once('open', resolve));
    anonymous.send('null');
    await new Promise(resolve => anonymous.once('message', resolve));
    a.socket.send('null');
    assert.equal((await a.wait(message => message.type === 'error' && message.message === 'Invalid message.')).message, 'Invalid message.');
    assert.equal((await api('/healthz')).status, 200, 'malformed messages cannot crash the server');
    a.send({ type: 'call:start', targetRoomId: to.id, mode: 'audio' });
    const replacedCall = await a.wait(message => message.type === 'call:outgoing' && ![outgoing.callId, second.callId].includes(message.callId));
    await b.wait(message => message.type === 'call:ring' && message.callId === replacedCall.callId);
    const newCallerTab = connect(caller);
    await newCallerTab.ready();
    assert.equal((await b.wait(message => message.type === 'call:ended' && message.callId === replacedCall.callId)).reason, 'replaced');
    assert.equal((await api('/api/bootstrap')).data.presence.find(item => item.roomId === to.id).busy, false);
    newCallerTab.send({ type: 'call:start', targetRoomId: to.id, mode: 'audio' });
    const timedCall = await newCallerTab.wait(message => message.type === 'call:outgoing');
    await b.wait(message => message.type === 'call:ring' && message.callId === timedCall.callId);
    b.send({ type: 'call:answer', callId: timedCall.callId });
    assert.equal((await newCallerTab.wait(message => message.type === 'call:ended' && message.callId === timedCall.callId, 3500)).reason, 'connection_timeout');
    const silentPeer = connect(receiverB, { autoPong: false });
    await silentPeer.ready();
    let staleGone = false;
    for (let i = 0; i < 40; i++) {
      const roomPresence = (await api('/api/bootstrap')).data.presence.find(item => item.roomId === to.id);
      if (roomPresence.online === 1) { staleGone = true; break; }
      await sleep(100);
    }
    assert.ok(staleGone, 'unresponsive peer must leave the online roster');
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8').includes('Receiver B'), true);
    assert.equal((await api('/api/bootstrap')).data.presence.find(item => item.roomId === to.id).online, 1);
    const newRoom = await api('/api/rooms', 'POST', { name: 'Workshop', area: 'Garage' }, true);
    assert.equal(newRoom.status, 201);
    assert.equal((await api('/api/bootstrap')).data.rooms.length, 5);
    assert.equal((await api(`/api/rooms/${to.id}`, 'DELETE', undefined, true)).status, 204);
    assert.equal((await b.wait(message => message.type === 'device:updated' && message.device.roomId === null)).device.id, receiverA.device.id);
    assert.equal((await api('/api/bootstrap')).data.rooms.length, 4);
    assert.equal((await api('/api/devices')).status, 401);
    assert.equal((await api('/api/devices', 'GET', undefined, true)).data.length, 3);
    assert.equal((await api(`/api/devices/${receiverA.device.id}`, 'DELETE', undefined, true)).status, 204);
    assert.equal((await api('/api/devices', 'GET', undefined, true)).data.length, 2);
    assert.equal((await api('/api/device', 'POST', { id: receiverA.device.id, token: receiverA.token, name: 'Receiver A', roomId: null })).status, 401);
  } finally {
    sockets.forEach(socket => socket.close());
    server?.kill('SIGTERM');
    await new Promise(resolve => server?.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
