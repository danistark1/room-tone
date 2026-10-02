import { useEffect, useRef, useState } from 'react';
import type { Profile } from './types';

type PushState = 'unavailable' | 'install' | 'loading' | 'ready' | 'enabled' | 'off' | 'pending-off' | 'denied' | 'working' | 'error';
type PushContext = { registration: ServiceWorkerRegistration; key: Uint8Array<ArrayBuffer>; subscription: PushSubscription | null };
const optOutKey = (id: string) => `roomtone-push-optout:${id}`;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
async function updateServer(profile: Profile, subscription: PushSubscription | null) {
  const response = await fetch('/api/push/subscription', {
    method: subscription ? 'POST' : 'DELETE', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: profile.device.id, token: profile.token, subscription: subscription?.toJSON() }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not update notification settings.');
  }
}

export function usePush(profile: Profile | null) {
  const [state, setState] = useState<PushState>('loading');
  const [error, setError] = useState('');
  const context = useRef<PushContext | null>(null);
  const savedProfile = useRef(profile);
  savedProfile.current = profile;

  useEffect(() => {
    let cancelled = false;
    context.current = null;
    if (!profile?.device.roomId) { setState('unavailable'); return; }
    if (isIOS() && !isInstalled()) { setState('install'); return; }
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setState('unavailable'); return;
    }
    setState('loading');
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        if (registration.active?.state !== 'activated') await navigator.serviceWorker.ready;
        const response = await fetch('/api/push/config', { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load notification settings.');
        const { publicKey } = await response.json() as { publicKey: string };
        const optedOut = localStorage.getItem(optOutKey(profile.device.id)) === '1';
        if (optedOut) {
          try { await updateServer(profile, null); }
          catch {
            if (!cancelled) { setError('Could not reach Roomtone to turn alerts off. Reconnect and retry.'); setState('pending-off'); }
            return;
          }
        }
        const subscription = Notification.permission === 'denied' ? null : await registration.pushManager.getSubscription();
        if (cancelled) return;
        context.current = { registration, key: decodeKey(publicKey), subscription };
        if (optedOut) {
          if (subscription) {
            try {
              if (!await subscription.unsubscribe()) throw new Error('Browser cleanup incomplete.');
              context.current.subscription = null;
            } catch { setError('Alerts are off on the server. Browser cleanup will retry when you reopen Roomtone.'); }
          }
          if (!cancelled) setState('off');
        } else if (Notification.permission === 'denied') {
          await updateServer(profile, null).catch(() => {});
          setState('denied');
        } else if (subscription) {
          await updateServer(profile, subscription);
          if (!cancelled) setState('enabled');
        } else {
          // Clearing an old server registration avoids advertising an unreachable device.
          await updateServer(profile, null).catch(() => {});
          if (!cancelled) setState('ready');
        }
      } catch (cause) {
        if (!cancelled) { setError((cause as Error).message); setState('error'); }
      }
    })();
    return () => { cancelled = true; context.current = null; };
  }, [profile?.device.id, profile?.device.roomId, profile?.token]);

  async function enable() {
    const setup = context.current;
    const current = savedProfile.current;
    if (!setup || !current?.device.roomId) return;
    setError('');
    try {
      // subscribe() is invoked from the button gesture; iOS requires this for permission.
      const pending = setup.subscription || setup.registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: setup.key,
      });
      setState('working');
      const subscription = await pending;
      await updateServer(current, subscription);
      setup.subscription = subscription;
      localStorage.removeItem(optOutKey(current.device.id));
      setState('enabled');
    } catch (cause) {
      setError(Notification.permission === 'denied'
        ? 'Notifications were declined. Allow Roomtone in your device’s notification settings, then try again.'
        : (cause as Error).message || 'Could not enable lock-screen notifications.');
      setState(Notification.permission === 'denied' ? 'denied' : 'error');
    }
  }

  async function disable() {
    const setup = context.current;
    const current = savedProfile.current;
    if (!current) return;
    localStorage.setItem(optOutKey(current.device.id), '1');
    setError(''); setState('working');
    try {
      await updateServer(current, null);
    } catch {
      setError('Could not reach Roomtone to turn alerts off. Reconnect and retry.');
      setState('pending-off'); return;
    }
    if (setup?.subscription) {
      try {
        if (!await setup.subscription.unsubscribe()) throw new Error('Browser cleanup incomplete.');
        setup.subscription = null;
      } catch {
        setError('Alerts are off on the server. Browser cleanup will retry when you reopen Roomtone.');
      }
    }
    setState('off');
  }

  return { state, error, enable, disable, isIOS: isIOS() };
}
