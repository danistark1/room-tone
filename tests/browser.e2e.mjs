import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const port = 33000 + Math.floor(Math.random() * 18000);
const origin = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), 'roomtone-browser-'));
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_PIN: 'browser-test-pin',
    NODE_ENV: 'test', PUSH_TEST_LOG: join(dir, 'push-deliveries.jsonl') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(origin + '/healthz')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The app server did not start.');
}
async function enroll(page, roomName, deviceName) {
  await page.goto(origin);
  await page.locator('#room-select').waitFor();
  await page.locator('#room-select').selectOption({ label: `${roomName} · Main floor` });
  await page.locator('#device-name').fill(deviceName);
  await page.getByRole('button', { name: 'Assign this device' }).click();
  await page.locator('#admin-pin').fill('browser-test-pin');
  await page.getByRole('button', { name: 'Unlock access' }).click();
  await page.locator('.connection-online').waitFor({ timeout: 10000 });
}
async function makeCall(caller, receiver, mode) {
  await caller.locator('.room-card', { hasText: 'Kitchen' }).click();
  await caller.locator('.detail-actions').getByRole('button', { name: mode === 'audio' ? 'Voice call' : 'Video call' }).click();
  await receiver.getByRole('button', { name: 'Answer call' }).waitFor({ timeout: 12000 });
  await receiver.getByRole('button', { name: 'Answer call' }).click();
  await caller.locator('.call-eyebrow', { hasText: 'CONNECTED' }).waitFor({ timeout: 15000 });
  await receiver.locator('.call-eyebrow', { hasText: 'CONNECTED' }).waitFor({ timeout: 15000 });
  if (process.env.ROOMTONE_CAPTURE_DIR && mode === 'audio') {
    await caller.screenshot({ path: join(process.env.ROOMTONE_CAPTURE_DIR, 'roomtone-call-preview.png') });
  }
  const tracks = await receiver.evaluate(() => {
    const remote = document.querySelector('audio, video.remote-video');
    return [...(remote?.srcObject?.getTracks() || [])].map(track => track.kind);
  });
  assert.ok(tracks.includes('audio'), `Receiver did not get remote audio in ${mode} call: ${tracks}`);
  if (mode === 'video') assert.ok(tracks.includes('video'), `Receiver did not get remote video: ${tracks}`);
  await caller.getByRole('button', { name: 'End call' }).click();
  await receiver.locator('.call-layer').waitFor({ state: 'detached', timeout: 8000 });
  console.log(`${mode} call connected with tracks: ${tracks.join(', ')}`);
}
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const contextA = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const contextB = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const caller = await contextA.newPage();
  const receiver = await contextB.newPage();
  const errors = [];
  caller.on('pageerror', error => errors.push('caller: ' + error.message));
  receiver.on('pageerror', error => errors.push('receiver: ' + error.message));
  await enroll(caller, 'Living room', 'Hall tablet');
  await enroll(receiver, 'Kitchen', 'Kitchen screen');
  const manifest = await (await receiver.request.get(origin + '/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  await receiver.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    if (!ready.active?.scriptURL.endsWith('/sw.js')) throw new Error('Roomtone service worker was not installed.');
  });
  await makeCall(caller, receiver, 'audio');
  await makeCall(caller, receiver, 'video');
  await receiver.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => constraints.video
      ? Promise.reject(new DOMException('Camera not found', 'NotFoundError'))
      : original(constraints);
  });
  await makeCall(caller, receiver, 'video');
  console.log('Microphone-only receiver answered video call with audio and received caller video.');
  await caller.locator('.sidebar-nav').getByRole('button', { name: 'Manage rooms' }).click();
  await caller.getByRole('button', { name: 'ADD ROOM' }).click();
  await caller.locator('#room-name').fill('Workshop');
  await caller.locator('#room-area').fill('Garage');
  await caller.getByRole('button', { name: 'Create room' }).click();
  await caller.locator('.manage-row', { hasText: 'Workshop' }).waitFor();
  await caller.getByRole('button', { name: 'Close settings' }).click();
  await caller.locator('.device-chip').click();
  await caller.locator('#room-select').selectOption({ label: 'Home office · Upstairs' });
  await caller.getByRole('button', { name: 'Assign this device' }).click();
  await caller.locator('.device-chip', { hasText: 'Home office' }).waitFor();
  console.log('Administrator room management and reassignment passed.');
  const phoneContext = await browser.newContext({ permissions: ['notifications'],
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1' });
  await phoneContext.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    const fake = {
      endpoint: 'https://web.push.apple.com/roomtone-ui-test',
      keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
      toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
      unsubscribe: async () => { throw new Error('Simulated browser unsubscribe failure'); },
    };
    Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: async () => ({ active: { state: 'activated' }, pushManager: {
      getSubscription: async () => localStorage.getItem('mock-subscribed') === '1' ? fake : null,
      subscribe: () => { localStorage.setItem('mock-subscribed', '1'); return Promise.resolve(fake); },
    } }) });
  });
  const phone = await phoneContext.newPage();
  phone.on('pageerror', error => errors.push('phone: ' + error.message));
  await enroll(phone, 'Entryway', 'Mock iPhone');
  await phone.getByRole('button', { name: 'Enable alerts' }).click();
  await phone.locator('.push-panel-copy strong', { hasText: 'alerts are on' }).waitFor();
  await caller.locator('.sidebar-nav').getByRole('button', { name: 'Manage rooms' }).click();
  await caller.getByRole('button', { name: 'Send test alert to Mock iPhone' }).click();
  await caller.locator('.device-test-result', { hasText: 'Push service accepted' }).waitFor();
  await caller.getByRole('button', { name: 'Close settings' }).click();
  await phone.getByRole('button', { name: 'Turn off alerts' }).click();
  await phone.locator('.push-panel-copy strong', { hasText: 'alerts are off' }).waitFor();
  await phone.reload();
  await phone.locator('.push-panel-copy strong', { hasText: 'alerts are off' }).waitFor();
  const inventory = await phone.evaluate(async () => (await fetch('/api/devices')).json());
  assert.equal(inventory.find(device => device.name === 'Mock iPhone').alerts, false,
    'a failed browser unsubscribe must not re-enable alerts on reload');
  await phone.getByRole('button', { name: 'Enable alerts' }).click();
  await phone.locator('.push-panel-copy strong', { hasText: 'alerts are on' }).waitFor();
  let failDeleteOnce = true;
  await phone.route('**/api/push/subscription', route => {
    if (route.request().method() === 'DELETE' && failDeleteOnce) {
      failDeleteOnce = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Simulated outage"}' });
    }
    return route.continue();
  });
  await phone.getByRole('button', { name: 'Turn off alerts' }).click();
  await phone.locator('.push-panel-copy strong', { hasText: 'Still turning alerts off' }).waitFor();
  assert.equal((await phone.evaluate(async () => (await fetch('/api/devices')).json())).find(device => device.name === 'Mock iPhone').alerts, true);
  await phone.reload();
  await phone.locator('.push-panel-copy strong', { hasText: 'alerts are off' }).waitFor();
  assert.equal((await phone.evaluate(async () => (await fetch('/api/devices')).json())).find(device => device.name === 'Mock iPhone').alerts, false);
  console.log('Alert opt-out survives failed browser cleanup and a server outage; re-enable remains deliberate.');
  await phoneContext.close();
  assert.deepEqual(errors, [], 'No unhandled browser exceptions');
  console.log('Two-browser voice and video WebRTC flows passed.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
}
