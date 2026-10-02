import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createPushService, describePushError, validSubscription } from './push.mjs';

const port = Number(process.env.PORT || 3000);
const dataPath = join(process.env.DATA_DIR || resolve('.data'), 'state.json');
const setupTimeoutMs = Math.max(1000, Number(process.env.CALL_SETUP_TIMEOUT_MS || 25000));
const heartbeatMs = Math.max(1000, Number(process.env.WS_HEARTBEAT_MS || 25000));
const isProduction = process.env.NODE_ENV === 'production';
const adminPin = process.env.ADMIN_PIN || (isProduction ? '' : '123456');
if (!adminPin || adminPin.length < 6) throw new Error('ADMIN_PIN must contain at least six characters.');

const seed = () => ({
  rooms: [
    { id: randomUUID(), name: 'Living room', area: 'Main floor' },
    { id: randomUUID(), name: 'Kitchen', area: 'Main floor' },
    { id: randomUUID(), name: 'Home office', area: 'Upstairs' },
    { id: randomUUID(), name: 'Entryway', area: 'Main floor' },
  ],
  devices: [],
});
mkdirSync(dirname(dataPath), { recursive: true });
const push = createPushService(dirname(dataPath), process.env.VAPID_SUBJECT || 'https://github.com/danistark1/room-tone');
let store = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : seed();
if (!existsSync(dataPath)) persist();
function persist() {
  const temp = `${dataPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(temp, dataPath);
}
const hash = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const sanitize = (value, max = 42) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
const roomById = id => store.rooms.find(room => room.id === id);
const deviceById = id => store.devices.find(device => device.id === id);
const publicDevice = device => ({ id: device.id, name: device.name, roomId: device.roomId });
const sessions = new Map();
const attempts = new Map();
const lastPushTest = new Map();
const online = new Map(); // device ID -> current websocket
const calls = new Map();

function presence() {
  const busyRooms = new Set();
  for (const call of calls.values()) {
    busyRooms.add(call.fromRoomId);
    busyRooms.add(call.targetRoomId);
  }
  return store.rooms.map(room => ({
    roomId: room.id,
    online: [...online.keys()].filter(id => deviceById(id)?.roomId === room.id).length,
    alerts: store.devices.filter(device => device.roomId === room.id && !online.has(device.id) && validSubscription(device.push)).length,
    busy: busyRooms.has(room.id),
  }));
}
function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function sendTo(id, message) { send(online.get(id), message); }
function broadcast(message) { for (const socket of online.values()) send(socket, message); }
function broadcastState() { broadcast({ type: 'state', rooms: store.rooms, presence: presence() }); }
function ringMessage(call) {
  return { type: 'call:ring', callId: call.id, fromRoom: roomById(call.fromRoomId),
    fromDevice: deviceById(call.callerId)?.name || 'A device', mode: call.mode };
}
function endCall(call, reason = 'ended') {
  if (!calls.has(call.id)) return;
  clearTimeout(call.timer);
  calls.delete(call.id);
  for (const id of new Set([call.callerId, ...call.ringingIds, call.calleeId].filter(Boolean))) {
    sendTo(id, { type: 'call:ended', callId: call.id, reason });
  }
  broadcastState();
}
function removeRingingDevice(call, id) {
  call.ringingIds.delete(id);
  if (call.status === 'ringing' && call.ringingIds.size === 0) endCall(call, 'unavailable');
}
async function notifyCall(call, ttl) {
  const targets = [...call.ringingIds].map(id => ({ id, subscription: validSubscription(deviceById(id)?.push) }))
    .filter(target => target.subscription);
  let changed = false;
  const delivered = await Promise.all(targets.map(async ({ id, subscription }) => {
    try {
      const result = await push.send(subscription, { type: 'call', callId: call.id, expiresAt: Date.now() + ttl * 1000 }, ttl);
      console.info(`Call push accepted for a device (${result?.statusCode || 'sent'}).`);
      return true;
    } catch (error) {
      console.warn(`Push delivery failed for a device (${describePushError(error)}).`);
      const device = deviceById(id);
      if ([404, 410].includes(error?.statusCode) && device?.push?.endpoint === subscription.endpoint) {
        delete device.push;
        changed = true;
        if (!online.has(id) && calls.has(call.id)) removeRingingDevice(call, id);
      }
      return false;
    }
  }));
  if (changed) { persist(); broadcastState(); }
  if (calls.has(call.id) && call.status === 'ringing' && !delivered.includes(true) &&
      ![...call.ringingIds].some(id => online.has(id))) endCall(call, 'push_unavailable');
}
function endCallsForDevice(deviceId, reason = 'disconnected', forceRemove = false) {
  for (const call of [...calls.values()]) {
    if (call.callerId === deviceId || call.calleeId === deviceId) endCall(call, reason);
    else if (call.ringingIds.has(deviceId) && (forceRemove || !validSubscription(deviceById(deviceId)?.push))) removeRingingDevice(call, deviceId);
  }
}
function cookieToken(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)rt_admin=([^;]+)/);
  return match?.[1];
}
function isAdmin(req) {
  const token = cookieToken(req);
  const expiry = token && sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Administrator PIN required.' });
const app = express();
app.disable('x-powered-by');
// The app container is not published by Compose; only one Caddy proxy hop can reach it.
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'no-cache');
  next();
});
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/bootstrap', (req, res) => res.json({ rooms: store.rooms, presence: presence(), admin: isAdmin(req) }));
app.get('/api/push/config', (_req, res) => res.json({ publicKey: push.publicKey }));
app.post('/api/admin/login', (req, res) => {
  const key = req.ip || 'unknown';
  const prior = attempts.get(key) || { count: 0, until: 0 };
  if (prior.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
  if (!safeEqual(pin, adminPin)) {
    prior.count += 1;
    if (prior.count >= 5) { prior.until = Date.now() + 15 * 60_000; prior.count = 0; }
    attempts.set(key, prior);
    return res.status(401).json({ error: 'Incorrect administrator PIN.' });
  }
  attempts.delete(key);
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + 8 * 60 * 60_000);
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `rt_admin=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${secure}`);
  res.json({ admin: true });
});
app.post('/api/admin/logout', (req, res) => {
  sessions.delete(cookieToken(req));
  res.setHeader('Set-Cookie', 'rt_admin=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0');
  res.json({ admin: false });
});
app.post('/api/rooms', requireAdmin, (req, res) => {
  const name = sanitize(req.body?.name);
  const area = sanitize(req.body?.area, 32) || 'Your space';
  if (!name) return res.status(400).json({ error: 'Room name is required.' });
  if (store.rooms.length >= 100) return res.status(400).json({ error: 'Room limit reached.' });
  const room = { id: randomUUID(), name, area };
  store.rooms.push(room); persist(); broadcastState();
  res.status(201).json(room);
});
app.patch('/api/rooms/:id', requireAdmin, (req, res) => {
  const room = roomById(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const name = sanitize(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Room name is required.' });
  room.name = name;
  room.area = sanitize(req.body?.area, 32) || 'Your space';
  persist(); broadcastState(); res.json(room);
});
app.delete('/api/rooms/:id', requireAdmin, (req, res) => {
  if (!roomById(req.params.id)) return res.status(404).json({ error: 'Room not found.' });
  for (const call of [...calls.values()]) {
    if (call.fromRoomId === req.params.id || call.targetRoomId === req.params.id) endCall(call, 'room_removed');
  }
  store.rooms = store.rooms.filter(room => room.id !== req.params.id);
  for (const device of store.devices) {
    if (device.roomId === req.params.id) {
      device.roomId = null;
      sendTo(device.id, { type: 'device:updated', device: publicDevice(device) });
    }
  }
  persist(); broadcastState(); res.status(204).end();
});
app.get('/api/devices', requireAdmin, (_req, res) => {
  res.json(store.devices.map(device => ({ ...publicDevice(device), online: online.has(device.id), alerts: !!validSubscription(device.push), updatedAt: device.updatedAt || null })));
});
app.post('/api/devices/:id/test-alert', requireAdmin, async (req, res) => {
  const device = deviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found.' });
  const subscription = device.roomId && validSubscription(device.push);
  if (!subscription) return res.status(409).json({ error: 'Enable lock-screen alerts on this device first.' });
  const now = Date.now();
  if (now - (lastPushTest.get(device.id) || 0) < 20_000) {
    return res.status(429).json({ error: 'Wait 20 seconds before sending another test alert.' });
  }
  lastPushTest.set(device.id, now);
  try {
    const result = await push.send(subscription, { type: 'test' }, 60);
    console.info(`Test push accepted for a device (${result?.statusCode || 'sent'}).`);
    res.json({ status: 'accepted', providerStatus: result?.statusCode || null });
  } catch (error) {
    const detail = describePushError(error);
    console.warn(`Test push failed for a device (${detail}).`);
    if ([404, 410].includes(error?.statusCode) && device.push?.endpoint === subscription.endpoint) {
      delete device.push;
      if (!online.has(device.id)) endCallsForDevice(device.id, 'disconnected', true);
      persist(); broadcastState();
    }
    res.status(502).json({ error: `Test alert failed (${detail}).`, providerStatus: error?.statusCode || null });
  }
});
app.delete('/api/devices/:id', requireAdmin, (req, res) => {
  if (!deviceById(req.params.id)) return res.status(404).json({ error: 'Device not found.' });
  lastPushTest.delete(req.params.id);
  endCallsForDevice(req.params.id, 'revoked', true);
  const socket = online.get(req.params.id);
  online.delete(req.params.id);
  socket?.close(1008, 'Device removed');
  store.devices = store.devices.filter(device => device.id !== req.params.id);
  persist(); broadcastState(); res.status(204).end();
});
app.post('/api/device', (req, res) => {
  const name = sanitize(req.body?.name, 32);
  const roomId = req.body?.roomId ?? null;
  if (!name) return res.status(400).json({ error: 'Device name is required.' });
  if (roomId !== null && !roomById(roomId)) return res.status(400).json({ error: 'Choose a valid room.' });
  let device;
  let token = req.body?.token;
  if (req.body?.id) {
    device = deviceById(req.body.id);
    if (!device || typeof token !== 'string' || hash(token) !== device.tokenHash) {
      return res.status(401).json({ error: 'Device authorization expired. Set up this browser again.' });
    }
    if (device.roomId !== roomId && !isAdmin(req)) return res.status(401).json({ error: 'Enter the administrator PIN to change rooms.' });
    if (device.roomId !== roomId) endCallsForDevice(device.id, 'room_changed', true);
    device.name = name;
    device.roomId = roomId;
    device.updatedAt = new Date().toISOString();
  } else {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Enter the administrator PIN to register and assign this device.' });
    if (store.devices.length >= 500) return res.status(400).json({ error: 'Device limit reached. Remove unused devices in Manage rooms.' });
    token = randomBytes(32).toString('base64url');
    device = { id: randomUUID(), tokenHash: hash(token), name, roomId, updatedAt: new Date().toISOString() };
    store.devices.push(device);
  }
  persist();
  sendTo(device.id, { type: 'device:updated', device: publicDevice(device) });
  broadcastState();
  res.json({ device: publicDevice(device), token });
});

function authorizedDevice(req) {
  const device = deviceById(req.body?.id);
  return device && typeof req.body?.token === 'string' && hash(req.body.token) === device.tokenHash ? device : null;
}
app.post('/api/push/subscription', (req, res) => {
  const device = authorizedDevice(req);
  if (!device) return res.status(401).json({ error: 'Assign this device before enabling alerts.' });
  if (!device.roomId) return res.status(400).json({ error: 'Assign this device to a room first.' });
  const subscription = validSubscription(req.body?.subscription);
  if (!subscription) return res.status(400).json({ error: 'Unsupported or invalid push subscription.' });
  device.push = subscription;
  persist(); broadcastState();
  res.json({ enabled: true });
});
app.delete('/api/push/subscription', (req, res) => {
  const device = authorizedDevice(req);
  if (!device) return res.status(401).json({ error: 'This device is no longer authorized.' });
  delete device.push;
  if (!online.has(device.id)) endCallsForDevice(device.id, 'disconnected', true);
  persist(); broadcastState();
  res.status(204).end();
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, heartbeatMs);
heartbeat.unref();
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  let sameOrigin = true;
  try { if (origin) sameOrigin = new URL(origin).host === req.headers.host; }
  catch { sameOrigin = false; }
  if (req.url !== '/socket' || !sameOrigin) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', socket => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  let deviceId = null;
  const helloTimer = setTimeout(() => socket.close(1008, 'Sign in required'), 10000);
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { send(socket, { type: 'error', message: 'Invalid message.' }); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      send(socket, { type: 'error', message: 'Invalid message.' }); return;
    }
    if (!deviceId) {
      if (message.type !== 'hello') { socket.close(1008, 'Device required'); return; }
      const device = deviceById(message.deviceId);
      if (!device || typeof message.token !== 'string' || hash(message.token) !== device.tokenHash) {
        socket.close(1008, 'Invalid device'); return;
      }
      clearTimeout(helloTimer);
      deviceId = device.id;
      const previousSocket = online.get(deviceId);
      if (previousSocket) {
        endCallsForDevice(deviceId, 'replaced');
        previousSocket.close(1000, 'Another tab opened');
      }
      online.set(deviceId, socket);
      send(socket, { type: 'ready', device: publicDevice(device), rooms: store.rooms, presence: presence() });
      for (const call of calls.values()) {
        if (call.status === 'ringing' && call.ringingIds.has(deviceId)) send(socket, ringMessage(call));
      }
      broadcastState(); return;
    }
    const device = deviceById(deviceId);
    if (!device?.roomId || !roomById(device.roomId)) {
      send(socket, { type: 'error', message: 'Assign this device to a room first.' }); return;
    }
    if (message.type === 'call:start') {
      const target = roomById(message.targetRoomId);
      const mode = message.mode === 'video' ? 'video' : 'audio';
      if (!target || target.id === device.roomId) { send(socket, { type: 'error', message: 'Choose another room.' }); return; }
      if ([...calls.values()].some(call => [call.fromRoomId, call.targetRoomId].includes(device.roomId) || [call.fromRoomId, call.targetRoomId].includes(target.id))) {
        send(socket, { type: 'error', message: 'One of these rooms is already on a call.' }); return;
      }
      const ringingIds = new Set(store.devices.filter(candidate => candidate.roomId === target.id &&
        (online.has(candidate.id) || validSubscription(candidate.push))).map(candidate => candidate.id));
      if (!ringingIds.size) { send(socket, { type: 'error', message: `${target.name} is offline right now.` }); return; }
      const hasPush = [...ringingIds].some(id => validSubscription(deviceById(id)?.push));
      const ringSeconds = hasPush ? 75 : 45;
      const call = {
        id: randomUUID(), callerId: deviceId, calleeId: null, fromRoomId: device.roomId,
        targetRoomId: target.id, ringingIds, mode, status: 'ringing', timer: null,
      };
      calls.set(call.id, call);
      call.timer = setTimeout(() => endCall(call, 'no_answer'), ringSeconds * 1000);
      send(socket, { type: 'call:outgoing', callId: call.id, targetRoom: target, mode });
      for (const id of ringingIds) sendTo(id, ringMessage(call));
      if (hasPush) void notifyCall(call, ringSeconds);
      broadcastState(); return;
    }
    const call = calls.get(message.callId);
    if (!call) { if (message.type !== 'signal') send(socket, { type: 'error', message: 'This call is no longer available.' }); return; }
    if (message.type === 'call:answer') {
      if (call.status !== 'ringing' || !call.ringingIds.has(deviceId)) return;
      call.status = 'connected'; call.calleeId = deviceId; clearTimeout(call.timer);
      call.mediaReady = new Set();
      call.timer = setTimeout(() => endCall(call, 'connection_timeout'), setupTimeoutMs);
      const caller = deviceById(call.callerId);
      for (const id of call.ringingIds) {
        if (id !== deviceId) sendTo(id, { type: 'call:answered_elsewhere', callId: call.id });
      }
      sendTo(call.callerId, { type: 'call:connected', callId: call.id, mode: call.mode, role: 'caller', peerRoom: roomById(call.targetRoomId), peerDevice: device.name });
      send(socket, { type: 'call:connected', callId: call.id, mode: call.mode, role: 'callee', peerRoom: roomById(call.fromRoomId), peerDevice: caller?.name });
      broadcastState(); return;
    }
    if (message.type === 'call:decline') {
      if (call.status === 'ringing' && call.ringingIds.has(deviceId)) removeRingingDevice(call, deviceId);
      return;
    }
    if (message.type === 'call:end') {
      if (call.callerId === deviceId || call.calleeId === deviceId) endCall(call, 'ended');
      else if (call.ringingIds.has(deviceId)) removeRingingDevice(call, deviceId);
      return;
    }
    if (message.type === 'call:media-ready' && call.status === 'connected' && [call.callerId, call.calleeId].includes(deviceId)) {
      call.mediaReady.add(deviceId);
      if (call.mediaReady.size === 2) clearTimeout(call.timer);
      return;
    }
    if (message.type === 'signal' && call.status === 'connected' && [call.callerId, call.calleeId].includes(deviceId)) {
      if (!['offer', 'answer', 'ice'].includes(message.signal?.kind) || JSON.stringify(message.signal).length > 180000) return;
      sendTo(deviceId === call.callerId ? call.calleeId : call.callerId, { type: 'signal', callId: call.id, signal: message.signal });
    }
  });
  socket.on('close', () => {
    clearTimeout(helloTimer);
    if (deviceId && online.get(deviceId) === socket) {
      online.delete(deviceId); endCallsForDevice(deviceId); broadcastState();
    }
  });
  socket.on('error', () => {});
});

const dist = resolve('dist');
if (existsSync(join(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false }));
  app.get('/{*splat}', (_req, res) => res.sendFile(join(dist, 'index.html')));
}
app.use((error, _req, res, _next) => res.status(400).json({ error: error?.message || 'Invalid request.' }));
server.listen(port, '0.0.0.0', () => console.log(`Roomtone listening on 0.0.0.0:${port}`));
