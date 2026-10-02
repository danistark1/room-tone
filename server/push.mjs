import webpush from 'web-push';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const allowedHost = host => host.endsWith('.push.apple.com') || host === 'fcm.googleapis.com' ||
  host === 'updates.push.services.mozilla.com' || host.endsWith('.notify.windows.com');
const base64url = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

// Never send server-originated requests to arbitrary URLs supplied by a device.
export function validSubscription(value) {
  if (!value || typeof value !== 'object' || typeof value.endpoint !== 'string' || value.endpoint.length > 2048) return null;
  let url;
  try { url = new URL(value.endpoint); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHost(url.hostname)) return null;
  const { p256dh, auth } = value.keys || {};
  if (!base64url(p256dh) || p256dh.length < 60 || p256dh.length > 200 ||
      !base64url(auth) || auth.length < 16 || auth.length > 100) return null;
  return { endpoint: url.href, keys: { p256dh, auth } };
}

export function describePushError(error) {
  let reason = '';
  try { reason = JSON.parse(error?.body || '{}').reason || ''; } catch { /* Non-JSON transport error. */ }
  if (!reason && typeof error?.code === 'string') reason = error.code;
  const safeReason = String(reason).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const status = Number(error?.statusCode);
  return [Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, safeReason || 'network_error']
    .filter(Boolean).join(' ');
}

export function createPushService(dataDir, subject) {
  if (!/^https:\/\/[^\s/]+(?:\/\S*)?$|^mailto:[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(subject) || /https:\/\/localhost(?::|\/|$)/i.test(subject)) {
    throw new Error('VAPID_SUBJECT must be a valid public HTTPS contact URL or mailto: address.');
  }
  const path = join(dataDir, 'vapid.json');
  let keys;
  if (existsSync(path)) {
    keys = JSON.parse(readFileSync(path, 'utf8'));
  } else {
    keys = webpush.generateVAPIDKeys();
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  }
  if (!base64url(keys.publicKey) || !base64url(keys.privateKey)) throw new Error('The saved VAPID keys are invalid. Restore the roomtone_data backup.');
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  return {
    publicKey: keys.publicKey,
    send(subscription, payload, ttl = 75) {
      // An opt-in, local test transport; production can never activate it.
      if (process.env.NODE_ENV === 'test' && process.env.PUSH_TEST_LOG) {
        appendFileSync(process.env.PUSH_TEST_LOG, JSON.stringify({ endpoint: subscription.endpoint, payload, ttl }) + '\n');
        return Promise.resolve({ statusCode: 201 });
      }
      return webpush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: ttl, urgency: 'high', timeout: 8000,
      });
    },
  };
}
