import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const code = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('the service worker shows a call alert and returns to the waiting app', async () => {
  const handlers = {};
  const notifications = [];
  const actions = [];
  let openWindows = [{ url: 'https://192.168.4.13:8443/',
    focus: async () => { actions.push('focus'); },
    postMessage: message => { actions.push(message); },
  }];
  const self = {
    location: { origin: 'https://192.168.4.13:8443' },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    registration: { showNotification: async (title, options) => { notifications.push({ title, options }); } },
    clients: {
      matchAll: async () => openWindows,
      openWindow: async url => { actions.push(url); },
      claim: async () => {},
    },
    skipWaiting: async () => {},
  };
  runInNewContext(code, { self, URL, Date });
  const event = { data: { json: () => ({ callId: 'call-123', expiresAt: Date.now() + 60000 }) },
    waitUntil(promise) { this.result = promise; } };
  handlers.push(event); await event.result;
  assert.equal(notifications[0].title, 'Incoming Roomtone call');
  assert.equal(notifications[0].options.tag, 'roomtone-call-123');
  assert.ok(!JSON.stringify(notifications[0]).includes('Living room'));
  const click = { notification: { data: notifications[0].options.data, close: () => actions.push('close') },
    waitUntil(promise) { this.result = promise; } };
  handlers.notificationclick(click); await click.result;
  assert.equal(actions[0], 'close');
  assert.equal(actions[1], 'focus');
  assert.equal(actions[2].callId, 'call-123');
  openWindows = [];
  handlers.notificationclick(click); await click.result;
  assert.equal(actions.at(-1), 'https://192.168.4.13:8443/?call=call-123');
  const expired = { data: { json: () => ({ callId: 'old-call', expiresAt: Date.now() - 1000 }) },
    waitUntil(promise) { this.result = promise; } };
  handlers.push(expired); await expired.result;
  assert.equal(notifications.at(-1).title, 'Missed Roomtone call');
});
