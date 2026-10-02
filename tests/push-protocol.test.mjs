import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { createPushService, describePushError, validSubscription } from '../server/push.mjs';

test('Apple-bound Web Push has an encrypted payload and a valid public contact claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roomtone-vapid-'));
  try {
    const subject = 'https://github.com/danistark1/room-tone';
    const service = createPushService(dir, subject);
    const keys = JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8'));
    assert.equal(service.publicKey, keys.publicKey);
    assert.equal(createPushService(dir, subject).publicKey, keys.publicKey);
    const receiver = createECDH('prime256v1'); receiver.generateKeys();
    const subscription = validSubscription({ endpoint: 'https://web.push.apple.com/opaque-device-endpoint',
      keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 4).toString('base64url') } });
    assert.ok(subscription);
    const details = webpush.generateRequestDetails(subscription, JSON.stringify({ type: 'call', callId: 'opaque-id' }), {
      vapidDetails: { subject, ...keys }, TTL: 75, urgency: 'high',
    });
    assert.equal(details.method, 'POST');
    assert.equal(details.headers.TTL, 75);
    assert.equal(details.headers.Urgency, 'high');
    assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
    assert.ok(details.body.length > 30 && !details.body.includes(Buffer.from('opaque-id')));
    const jwt = details.headers.Authorization.match(/t=([^,]+)/)[1];
    const claim = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    assert.equal(claim.sub, subject);
    assert.equal(claim.aud, 'https://web.push.apple.com');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Apple rejection and network failure diagnostics contain only safe status and reason codes', () => {
  assert.equal(describePushError({ statusCode: 403, body: '{"reason":"BadJwtToken"}' }), '403 BadJwtToken');
  assert.equal(describePushError({ statusCode: 410, body: '{"reason":"ExpiredToken"}' }), '410 ExpiredToken');
  assert.equal(describePushError({ code: 'ETIMEDOUT' }), 'ETIMEDOUT');
  assert.equal(describePushError({ statusCode: 500, body: '{"reason":"Bad\nSecret"}' }), '500 network_error');
});
