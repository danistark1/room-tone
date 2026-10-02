import { useEffect, useRef, useState } from 'react';
import type { AdminDevice, Call, Device, Mode, Presence, Profile, Room } from './types';

const storageKey = 'roomtone-device-v1';
const readProfile = (): Profile | null => {
  try { return JSON.parse(localStorage.getItem(storageKey) || 'null') as Profile | null; }
  catch { return null; }
};
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
const send = (socket: WebSocket | null, message: object) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

export function useIntercom() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [profile, setProfile] = useState<Profile | null>(readProfile);
  const [admin, setAdmin] = useState(false);
  const [online, setOnline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [call, setCall] = useState<Call | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const profileRef = useRef(profile);
  const callRef = useRef<Call | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const iceQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);

  async function enableAlerts() {
    try {
      audioContextRef.current ||= new AudioContext();
      await audioContextRef.current.resume();
      setAlertsEnabled(audioContextRef.current.state === 'running');
    } catch { setAlertsEnabled(false); }
  }
  useEffect(() => {
    const unlockOnGesture = () => { void enableAlerts(); };
    document.addEventListener('pointerdown', unlockOnGesture, { once: true });
    return () => document.removeEventListener('pointerdown', unlockOnGesture);
  }, []);
  useEffect(() => {
    if (!alertsEnabled || call?.direction !== 'incoming' || call.phase !== 'ringing') return;
    const chime = () => {
      const context = audioContextRef.current;
      if (!context || context.state !== 'running') return;
      [0, 0.19].forEach((delay, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + delay;
        oscillator.type = 'sine'; oscillator.frequency.value = index ? 880 : 660;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.09, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start); oscillator.stop(start + 0.31);
      });
    };
    chime();
    const id = setInterval(chime, 2600);
    return () => clearInterval(id);
  }, [alertsEnabled, call?.direction, call?.phase, call?.id]);

  function setCurrentCall(next: Call | null) { callRef.current = next; setCall(next); }
  function updateCall(patch: Partial<Call>) {
    if (callRef.current) setCurrentCall({ ...callRef.current, ...patch });
  }
  function stopMedia() {
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
    disconnectTimerRef.current = null;
    const peer = peerRef.current;
    if (peer) { peer.onconnectionstatechange = null; peer.onicecandidate = null; peer.ontrack = null; peer.close(); }
    peerRef.current = null;
    iceQueueRef.current = [];
    localRef.current?.getTracks().forEach(track => track.stop());
    localRef.current = null;
    setLocalStream(null); setRemoteStream(null); setCurrentCall(null);
  }
  function createPeer() {
    if (peerRef.current) return peerRef.current;
    const peer = new RTCPeerConnection({ iceServers: [] });
    peerRef.current = peer;
    for (const track of localRef.current?.getTracks() || []) peer.addTrack(track, localRef.current!);
    if (callRef.current?.mode === 'video' && !localRef.current?.getVideoTracks().length) {
      peer.addTransceiver('video', { direction: 'recvonly' });
    }
    peer.onicecandidate = event => {
      if (event.candidate && callRef.current?.id) send(socketRef.current, {
        type: 'signal', callId: callRef.current.id,
        signal: { kind: 'ice', candidate: event.candidate.toJSON() },
      });
    };
    peer.ontrack = event => {
      setRemoteStream(new MediaStream(event.streams[0]?.getTracks() || [event.track]));
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
        updateCall({ phase: 'connected', startedAt: callRef.current?.startedAt || Date.now() });
        send(socketRef.current, { type: 'call:media-ready', callId: callRef.current?.id });
      }
      if (peer.connectionState === 'disconnected' && !disconnectTimerRef.current) {
        disconnectTimerRef.current = setTimeout(() => {
          if (peerRef.current === peer && peer.connectionState === 'disconnected') {
            setError('The other device lost its network connection.');
            send(socketRef.current, { type: 'call:end', callId: callRef.current?.id });
            stopMedia();
          }
        }, 12000);
      }
      if (peer.connectionState === 'failed') {
        setError('The devices could not connect directly. Check that both are on the same reachable LAN.');
        send(socketRef.current, { type: 'call:end', callId: callRef.current?.id });
        stopMedia();
      }
    };
    return peer;
  }
  async function handleSignal(signal: { kind: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    try {
      const peer = createPeer();
      if (signal.kind === 'ice' && signal.candidate) {
        if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate);
        else iceQueueRef.current.push(signal.candidate);
        return;
      }
      if ((signal.kind === 'offer' || signal.kind === 'answer') && signal.sdp) {
        await peer.setRemoteDescription(signal.sdp);
        for (const candidate of iceQueueRef.current.splice(0)) await peer.addIceCandidate(candidate);
        if (signal.kind === 'offer') {
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          send(socketRef.current, { type: 'signal', callId: callRef.current?.id, signal: { kind: 'answer', sdp: peer.localDescription } });
        }
      }
    } catch {
      setError('The call could not be connected. Please try again.');
      send(socketRef.current, { type: 'call:end', callId: callRef.current?.id });
      stopMedia();
    }
  }
  function handleMessage(message: any) {
    if (message.type === 'ready' || message.type === 'state') {
      setRooms(message.rooms || []); setPresence(message.presence || []);
      if (message.type === 'ready') {
        setOnline(true);
        if (profileRef.current) {
          const next = { ...profileRef.current, device: message.device as Device };
          profileRef.current = next; setProfile(next); localStorage.setItem(storageKey, JSON.stringify(next));
        }
      }
    }
    if (message.type === 'device:updated' && profileRef.current) {
      const next = { ...profileRef.current, device: message.device as Device };
      profileRef.current = next; setProfile(next); localStorage.setItem(storageKey, JSON.stringify(next));
      if (!message.device.roomId) setError('This device’s room was removed. Assign it to a new room.');
    }
    if (message.type === 'call:ring' && !callRef.current) {
      setCurrentCall({ id: message.callId, phase: 'ringing', direction: 'incoming', mode: message.mode,
        peerRoom: message.fromRoom, peerDevice: message.fromDevice, muted: false, cameraOff: false });
      if ('vibrate' in navigator) navigator.vibrate([180, 120, 180]);
    }
    if (message.type === 'call:outgoing' && callRef.current?.direction === 'outgoing') {
      updateCall({ id: message.callId, phase: 'ringing' });
    }
    if (message.type === 'call:connected' && callRef.current?.id === message.callId) {
      updateCall({ phase: 'connecting', peerRoom: message.peerRoom, peerDevice: message.peerDevice });
      const peer = createPeer();
      if (message.role === 'caller') {
        (async () => {
          try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            send(socketRef.current, { type: 'signal', callId: message.callId, signal: { kind: 'offer', sdp: peer.localDescription } });
          } catch { setError('Unable to start the connection.'); endCall(); }
        })();
      }
    }
    if (message.type === 'signal' && callRef.current?.id === message.callId) void handleSignal(message.signal);
    if ((message.type === 'call:ended' || message.type === 'call:answered_elsewhere') && callRef.current?.id === message.callId) {
      const reason: Record<string, string> = {
        no_answer: 'No one answered that room.', unavailable: 'No devices are available in that room.',
        push_unavailable: 'The room’s lock-screen notification could not be delivered. Check internet access and alert settings.',
        disconnected: 'The other device disconnected.', room_removed: 'This room was removed.', room_changed: 'The device changed rooms.',
        connection_timeout: 'The devices could not establish a direct connection.', replaced: 'This device was opened in another tab.',
      };
      if (message.type === 'call:answered_elsewhere') setError('Another device in this room answered.');
      else if (reason[message.reason]) setError(reason[message.reason]);
      stopMedia();
    }
    if (message.type === 'error') {
      setError(message.message || 'Something went wrong.');
      if (callRef.current?.direction === 'outgoing' && !callRef.current.id) stopMedia();
    }
  }
  function connect(saved: Profile) {
    if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/socket`);
    socketRef.current = socket;
    socket.onopen = () => send(socket, { type: 'hello', deviceId: saved.device.id, token: saved.token });
    socket.onmessage = event => {
      try { handleMessage(JSON.parse(event.data)); } catch { setError('Received an invalid server message.'); }
    };
    socket.onclose = event => {
      if (socketRef.current !== socket) return;
      setOnline(false); stopMedia();
      if (event.code === 1008) {
        profileRef.current = null; setProfile(null); localStorage.removeItem(storageKey);
        setError('This device was removed or its authorization expired. Ask an administrator to assign it again.');
        return;
      }
      if (event.reason === 'Another tab opened') {
        setError('Roomtone is open in another tab on this device. Use that tab for calls.');
        return;
      }
      if (!intentionalCloseRef.current && profileRef.current) {
        reconnectRef.current = setTimeout(() => connect(profileRef.current!), 2500);
      }
    };
  }
  useEffect(() => {
    intentionalCloseRef.current = false;
    request<{ rooms: Room[]; presence: Presence[]; admin: boolean }>('/api/bootstrap')
      .then(data => { setRooms(data.rooms); setPresence(data.presence); setAdmin(data.admin); })
      .catch(() => setError('Cannot reach the Roomtone server. Check your connection.'))
      .finally(() => setLoaded(true));
    const saved = profileRef.current;
    if (saved) connect(saved);
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const resume = () => {
      if (document.visibilityState === 'visible' && profileRef.current && socketRef.current?.readyState !== WebSocket.OPEN) {
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        connect(profileRef.current);
      }
    };
    const checkCall = (id: string) => {
      if (!id) return;
      resume();
      timeouts.push(setTimeout(() => {
        if (!callRef.current || callRef.current.id !== id) setError('That call has already ended. Ask the other room to try again.');
      }, 3500));
    };
    const fromNotification = (event: MessageEvent) => {
      if (event.data?.type === 'roomtone:open-call') checkCall(event.data.callId);
    };
    const incomingId = new URLSearchParams(location.search).get('call');
    if (incomingId) {
      history.replaceState(null, '', location.pathname);
      checkCall(incomingId);
    }
    document.addEventListener('visibilitychange', resume);
    navigator.serviceWorker?.addEventListener('message', fromNotification);
    return () => {
      intentionalCloseRef.current = true;
      document.removeEventListener('visibilitychange', resume);
      navigator.serviceWorker?.removeEventListener('message', fromNotification);
      for (const timeout of timeouts) clearTimeout(timeout);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      localRef.current?.getTracks().forEach(track => track.stop());
      peerRef.current?.close();
      const previousAudioContext = audioContextRef.current;
      audioContextRef.current = null;
      void previousAudioContext?.close();
    };
  }, []);

  async function unlock(pin: string) {
    await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ pin }) });
    setAdmin(true);
  }
  async function lock() {
    await request('/api/admin/logout', { method: 'POST' });
    setAdmin(false);
  }
  async function assign(name: string, roomId: string) {
    const saved = profileRef.current;
    const result = await request<Profile>('/api/device', { method: 'POST', body: JSON.stringify({
      id: saved?.device.id, token: saved?.token, name, roomId,
    }) });
    profileRef.current = result; setProfile(result);
    localStorage.setItem(storageKey, JSON.stringify(result));
    if (!saved) connect(result);
    return result;
  }
  async function createRoom(name: string, area: string) {
    await request('/api/rooms', { method: 'POST', body: JSON.stringify({ name, area }) });
    const data = await request<{ rooms: Room[] }>('/api/bootstrap'); setRooms(data.rooms);
  }
  async function editRoom(id: string, name: string, area: string) {
    await request(`/api/rooms/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name, area }) });
    const data = await request<{ rooms: Room[] }>('/api/bootstrap'); setRooms(data.rooms);
  }
  async function deleteRoom(id: string) {
    await request(`/api/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await request<{ rooms: Room[] }>('/api/bootstrap'); setRooms(data.rooms);
  }
  async function listDevices() { return request<AdminDevice[]>('/api/devices'); }
  async function revokeDevice(id: string) { await request(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  async function acquire(mode: Mode) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs trusted HTTPS. See the setup guide for this device.');
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true },
        video: mode === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false });
    } catch (cause) {
      const name = (cause as DOMException).name;
      if (mode === 'video' && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
        try {
          const audio = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
          setError('No camera found. Continuing with voice on this device.');
          return audio;
        } catch { throw new Error('No microphone found on this device.'); }
      }
      if (name === 'NotAllowedError') throw new Error('Allow microphone and camera access in your browser to place this call.');
      if (name === 'NotFoundError') throw new Error('No microphone found on this device.');
      throw new Error('Could not start your microphone or camera. Check browser permissions.');
    }
  }
  async function startCall(target: Room, mode: Mode) {
    if (!online || callRef.current) return;
    setError('');
    setCurrentCall({ id: '', phase: 'preparing', direction: 'outgoing', mode, peerRoom: target,
      muted: false, cameraOff: false });
    try {
      const stream = await acquire(mode);
      const pendingCall = callRef.current as Call | null;
      if (!pendingCall || pendingCall.direction !== 'outgoing') { stream.getTracks().forEach(track => track.stop()); return; }
      localRef.current = stream; setLocalStream(stream);
      if (mode === 'video' && !stream.getVideoTracks().length) updateCall({ cameraOff: true });
      send(socketRef.current, { type: 'call:start', targetRoomId: target.id, mode });
    } catch (cause) { stopMedia(); setError((cause as Error).message); }
  }
  async function answerCall() {
    const current = callRef.current;
    if (!current || current.direction !== 'incoming' || current.phase !== 'ringing') return;
    setError('');
    updateCall({ phase: 'preparing' });
    try {
      const stream = await acquire(current.mode);
      if (callRef.current?.id !== current.id) { stream.getTracks().forEach(track => track.stop()); return; }
      localRef.current = stream; setLocalStream(stream);
      if (current.mode === 'video' && !stream.getVideoTracks().length) updateCall({ cameraOff: true });
      createPeer(); updateCall({ phase: 'connecting' });
      send(socketRef.current, { type: 'call:answer', callId: current.id });
    } catch (cause) { updateCall({ phase: 'ringing' }); setError((cause as Error).message); }
  }
  function endCall() {
    const current = callRef.current;
    if (current?.id) send(socketRef.current, { type: current.direction === 'incoming' && current.phase === 'ringing' ? 'call:decline' : 'call:end', callId: current.id });
    stopMedia();
  }
  function toggleMute() {
    const current = callRef.current;
    if (!current) return;
    const muted = !current.muted;
    localRef.current?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    updateCall({ muted });
  }
  function toggleCamera() {
    const current = callRef.current;
    if (!current || current.mode !== 'video') return;
    if (!localRef.current?.getVideoTracks().length) { setError('This device has no camera. Voice is still connected.'); return; }
    const cameraOff = !current.cameraOff;
    localRef.current?.getVideoTracks().forEach(track => { track.enabled = !cameraOff; });
    updateCall({ cameraOff });
  }
  return { rooms, presence, profile, admin, online, loaded, error, setError, call, localStream, remoteStream, alertsEnabled, enableAlerts,
    unlock, lock, assign, createRoom, editRoom, deleteRoom, listDevices, revokeDevice,
    startCall, answerCall, endCall, toggleMute, toggleCamera };
}
