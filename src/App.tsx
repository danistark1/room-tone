import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, AudioLines, Check, ChevronRight,
  DoorOpen, Headphones, House, Laptop, LockKeyhole, Menu, Mic, MicOff, Pencil, Phone,
  PhoneOff, Plus, Settings2, Shield, Trash2, Utensils, Video, VideoOff, Wifi, WifiOff, X,
} from 'lucide-react';
import { useIntercom } from './useIntercom';
import type { AdminDevice, Presence, Room } from './types';
import './styles.css';

type Intercom = ReturnType<typeof useIntercom>;
function Mark({ small = false }: { small?: boolean }) {
  return <span className={`mark ${small ? 'mark-small' : ''}`} aria-hidden="true"><i/><i/><i/><i/></span>;
}
function RoomIcon({ room, index }: { room: Room; index: number }) {
  const name = room.name.toLowerCase();
  const Icon = /kitchen|dining|pantry/.test(name) ? Utensils : /office|study|desk/.test(name) ? Laptop :
    /entry|door|porch|gate/.test(name) ? DoorOpen : House;
  return <span className={`room-icon icon-tone-${index % 4}`}><Icon size={23} strokeWidth={1.6}/></span>;
}
function Status({ status, count }: { status: Presence | undefined; count?: boolean }) {
  const text = status?.busy ? 'On a call' : status?.online ? count ? `${status.online} ${status.online === 1 ? 'device' : 'devices'} online` : 'Available' : 'Offline';
  return <span className={`status ${status?.busy ? 'status-busy' : status?.online ? 'status-online' : 'status-offline'}`}>
    <span className="status-dot"/>{text}
  </span>;
}
function TimeDisplay({ start }: { start?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  if (!start) return <>Connecting…</>;
  const elapsed = Math.floor((now - start) / 1000);
  return <>{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</>;
}
function VideoSurface({ stream, muted = false, className = '' }: { stream: MediaStream | null; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted}/>;
}
function AudioSurface({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return <audio ref={ref} autoPlay/>;
}
function CallLayer({ app }: { app: Intercom }) {
  const { call, localStream, remoteStream, answerCall, endCall, toggleMute, toggleCamera } = app;
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { layerRef.current?.focus(); }, [call?.id]);
  if (!call) return null;
  const incoming = call.direction === 'incoming' && call.phase === 'ringing';
  const outgoing = call.direction === 'outgoing' && ['preparing', 'ringing'].includes(call.phase);
  const inConversation = !incoming && !outgoing;
  return <div ref={layerRef} tabIndex={-1} className={`call-layer ${call.mode === 'video' ? 'call-video' : ''}`} role="dialog" aria-modal="true" aria-label={`${call.mode} call with ${call.peerRoom.name}`}>
    <div className="call-ambient call-ambient-one"/><div className="call-ambient call-ambient-two"/>
    <div className="call-topbar">
      <div className="call-brand"><Mark small/> ROOMTONE <span className="call-brand-divider"/> LIVE CONNECTION</div>
      <div className="call-encryption"><Shield size={14}/> PRIVATE ON YOUR NETWORK</div>
    </div>
    <div className="call-stage">
      {call.mode === 'video' && inConversation && remoteStream?.getVideoTracks().length ?
        <VideoSurface stream={remoteStream} className="remote-video"/> : null}
      {call.mode === 'audio' && remoteStream ? <AudioSurface stream={remoteStream}/> : null}
      {call.mode === 'video' && remoteStream && !remoteStream.getVideoTracks().length ? <AudioSurface stream={remoteStream}/> : null}
      <div className={`call-identity ${call.mode === 'video' && remoteStream?.getVideoTracks().length ? 'call-identity-on-video' : ''}`}>
        <div className={`call-orbit ${incoming || outgoing ? 'ringing' : inConversation ? 'live' : ''}`}>
          <div className="orbit-ring orbit-ring-one"/><div className="orbit-ring orbit-ring-two"/>
          <div className="orbit-core"><RoomIcon room={call.peerRoom} index={0}/></div>
        </div>
        <div className="call-eyebrow"><span className="live-dot"/> {incoming ? 'INCOMING CALL' : outgoing ? 'CALLING ROOM' : call.phase === 'connected' ? 'CONNECTED' : 'CONNECTING'}</div>
        <h2>{call.peerRoom.name}</h2>
        <p>{incoming ? `${call.peerDevice || 'A device'} is calling your room` : outgoing ? 'Waiting for someone to answer…' : call.phase === 'connected' ? <TimeDisplay start={call.startedAt}/> : 'Opening a private connection…'}</p>
      </div>
      {call.mode === 'video' && inConversation && localStream?.getVideoTracks().length ?
        <div className="local-video-wrap"><VideoSurface stream={localStream} className="local-video" muted/><span>YOU {call.cameraOff ? '· CAMERA OFF' : ''}</span></div> : null}
    </div>
    <div className="call-bottom">
      <div className="call-context"><span className="context-line"/> {call.mode === 'video' ? 'VIDEO' : 'VOICE'} · ROOM TO ROOM</div>
      <div className="call-controls">
        {incoming ? <>
          <button className="call-control control-decline" onClick={endCall} aria-label="Decline call"><PhoneOff size={23}/></button>
          <button className="answer-button" onClick={answerCall}><Phone size={20} fill="currentColor"/> Answer call</button>
        </> : <>
          {inConversation && <>
            <button className={`call-control ${call.muted ? 'control-toggled' : ''}`} onClick={toggleMute} aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'} title={call.muted ? 'Unmute' : 'Mute'}>{call.muted ? <MicOff size={22}/> : <Mic size={22}/>}</button>
            {call.mode === 'video' && <button className={`call-control ${call.cameraOff ? 'control-toggled' : ''}`} onClick={toggleCamera} aria-label={call.cameraOff ? 'Turn on camera' : 'Turn off camera'} title={call.cameraOff ? 'Turn on camera' : 'Turn off camera'}>{call.cameraOff ? <VideoOff size={22}/> : <Video size={22}/>}</button>}
          </>}
          <button className="call-control control-decline" onClick={endCall} aria-label="End call" title="End call"><PhoneOff size={23}/></button>
        </>}
      </div>
      <span className="call-context call-context-right">END-TO-END ENCRYPTED</span>
    </div>
  </div>;
}
function PinModal({ onClose, onSubmit, busy, error }: { onClose: () => void; onSubmit: (pin: string) => void; busy: boolean; error: string }) {
  const [pin, setPin] = useState('');
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="dialog pin-dialog" onSubmit={event => { event.preventDefault(); onSubmit(pin); }}>
      <button className="icon-button dialog-close" type="button" onClick={onClose} aria-label="Close"><X size={19}/></button>
      <div className="dialog-icon"><LockKeyhole size={24}/></div>
      <div className="eyebrow">ADMINISTRATOR ACCESS</div><h2>Make it yours.</h2>
      <p>Enter the administrator PIN to manage rooms or assign this device. You’ll stay unlocked for this browser session.</p>
      <label className="field-label" htmlFor="admin-pin">ADMINISTRATOR PIN</label>
      <input id="admin-pin" autoFocus type="password" minLength={6} value={pin} onChange={event => setPin(event.target.value)} placeholder="Enter your PIN" autoComplete="off"/>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button full-button" disabled={busy || pin.length < 6} type="submit">{busy ? 'Checking…' : 'Unlock access'} <ArrowRight size={18}/></button>
    </form>
  </div>;
}
function DeviceSetup({ app, onAssign, onManage, onClose, inactive }: { app: Intercom; onAssign: (name: string, roomId: string) => void; onManage: () => void; onClose: () => void; inactive: boolean }) {
  const [name, setName] = useState(app.profile?.device.name || 'This device');
  const [roomId, setRoomId] = useState(app.profile?.device.roomId || '');
  useEffect(() => { if (app.profile?.device.roomId) setRoomId(app.profile.device.roomId); }, [app.profile?.device.roomId]);
  return <div className="modal-backdrop setup-backdrop" inert={inactive}>
    <form className="dialog setup-dialog" onSubmit={event => { event.preventDefault(); onAssign(name.trim(), roomId); }}>
      {app.profile?.device.roomId && <button className="icon-button dialog-close setup-close" type="button" onClick={onClose} aria-label="Close device settings"><X size={19}/></button>}
      <div className="setup-visual"><div className="setup-visual-inner"><Mark/><span className="setup-orbit orbit-a"/><span className="setup-orbit orbit-b"/></div><div className="setup-visual-label">ROOMTONE / DEVICE SETUP</div></div>
      <div className="setup-body"><div className="eyebrow">ONE LITTLE SETUP</div><h2>Give this device<br/><em>a place to belong.</em></h2>
        <p>Choose the room this browser lives in. An administrator PIN is required to assign it.</p>
        <label className="field-label" htmlFor="device-name">DEVICE NAME</label>
        <input id="device-name" autoFocus maxLength={32} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Hallway tablet"/>
        <label className="field-label" htmlFor="room-select">ASSIGN TO ROOM</label>
        <select id="room-select" value={roomId} onChange={event => setRoomId(event.target.value)} required>
          <option value="">Choose a room</option>{app.rooms.map(room => <option key={room.id} value={room.id}>{room.name} · {room.area}</option>)}
        </select>
        {app.rooms.length === 0 && <p className="setup-hint">No rooms yet. <button type="button" className="inline-link" onClick={onManage}>Create the first room</button> with the administrator PIN.</p>}
        <button className="primary-button full-button" type="submit" disabled={!name.trim() || !roomId}>Assign this device <ArrowRight size={18}/></button>
        <div className="setup-footer"><Shield size={15}/> Stays entirely on your local network.</div>
      </div>
    </form>
  </div>;
}
function ManagePanel({ app, onClose }: { app: Intercom; onClose: () => void }) {
  const [editing, setEditing] = useState<Room | null>(null);
  const [creating, setCreating] = useState(false);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [revokingDevice, setRevokingDevice] = useState<AdminDevice | null>(null);
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [deleting, setDeleting] = useState<Room | null>(null);
  useEffect(() => {
    void app.listDevices().then(setDevices).catch(cause => setLocalError((cause as Error).message));
  }, [app.rooms]);
  const edit = (room: Room) => { setEditing(room); setCreating(false); setName(room.name); setArea(room.area); setLocalError(''); };
  const create = () => { setEditing(null); setCreating(true); setName(''); setArea(''); setLocalError(''); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setLocalError('');
    try {
      if (editing) await app.editRoom(editing.id, name, area);
      else await app.createRoom(name, area);
      setEditing(null); setCreating(false); setName(''); setArea('');
    } catch (cause) { setLocalError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try { await app.deleteRoom(deleting.id); setDeleting(null); }
    catch (cause) { setLocalError((cause as Error).message); setDeleting(null); }
    finally { setBusy(false); }
  };
  const revoke = async () => {
    if (!revokingDevice) return;
    setBusy(true);
    try { await app.revokeDevice(revokingDevice.id); setDevices(items => items.filter(item => item.id !== revokingDevice.id)); setRevokingDevice(null); }
    catch (cause) { setLocalError((cause as Error).message); setRevokingDevice(null); }
    finally { setBusy(false); }
  };
  return <div className="panel-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="manage-panel" aria-label="Manage rooms">
      <div className="panel-top"><div className="eyebrow">YOUR SPACE / SETTINGS</div><button className="icon-button" autoFocus onClick={onClose} aria-label="Close settings"><X size={19}/></button></div>
      <h2>Make room<br/><em>for everyone.</em></h2><p className="panel-intro">Create and organize the rooms your devices can call.</p>
      <div className="panel-section-heading"><span>YOUR ROOMS <b>{app.rooms.length.toString().padStart(2, '0')}</b></span><button onClick={create} className="text-button"><Plus size={16}/> ADD ROOM</button></div>
      <div className="manage-list">{app.rooms.map((room, index) => <div className="manage-row" key={room.id}>
        <RoomIcon room={room} index={index}/><div className="manage-row-copy"><strong>{room.name}</strong><span>{room.area}</span></div>
        <button className="icon-button" onClick={() => edit(room)} aria-label={`Edit ${room.name}`}><Pencil size={17}/></button>
        <button className="icon-button danger-hover" onClick={() => setDeleting(room)} aria-label={`Delete ${room.name}`}><Trash2 size={17}/></button>
      </div>)}</div>
      {(creating || editing) && <form className="room-form" onSubmit={save}>
        <div className="room-form-heading"><strong>{editing ? 'Edit room' : 'New room'}</strong><button type="button" className="icon-button" onClick={() => { setEditing(null); setCreating(false); }}><X size={16}/></button></div>
        <label className="field-label" htmlFor="room-name">ROOM NAME</label><input id="room-name" autoFocus required maxLength={42} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Nursery"/>
        <label className="field-label" htmlFor="room-area">AREA / FLOOR</label><input id="room-area" maxLength={32} value={area} onChange={event => setArea(event.target.value)} placeholder="e.g. Upstairs"/>
        {localError && <div className="form-error">{localError}</div>}
        <button type="submit" className="primary-button full-button" disabled={busy || !name.trim()}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create room'} <Check size={17}/></button>
      </form>}
      {localError && !creating && !editing && <div className="form-error">{localError}</div>}
      <div className="panel-section-heading device-heading"><span>REGISTERED DEVICES <b>{devices.length.toString().padStart(2, '0')}</b></span></div>
      <div className="manage-list device-list">{devices.map(device => <div className="manage-row" key={device.id}>
        <span className="device-list-icon"><Headphones size={18}/></span><div className="manage-row-copy"><strong>{device.name}</strong><span>{app.rooms.find(room => room.id === device.roomId)?.name || 'Unassigned'} · {device.online ? 'Online' : 'Offline'}</span></div>
        <button className="icon-button danger-hover" onClick={() => setRevokingDevice(device)} aria-label={`Remove ${device.name}`} title="Remove device"><Trash2 size={17}/></button>
      </div>)}{!devices.length && <div className="device-empty">No devices registered yet.</div>}</div>
      <div className="panel-footer"><Shield size={18}/><span>Only someone with the administrator PIN can make changes to rooms or device assignments.</span></div>
      <button className="lock-admin" onClick={() => { void app.lock().then(onClose).catch(cause => setLocalError((cause as Error).message)); }}><LockKeyhole size={15}/> Lock administrator access</button>
    </aside>
    {deleting && <div className="modal-backdrop confirm-backdrop"><div className="dialog confirm-dialog"><div className="dialog-icon danger-icon"><Trash2 size={22}/></div><h2>Remove {deleting.name}?</h2><p>Assigned devices will lose their room, and any active call with this room will end. This cannot be undone.</p><div className="confirm-actions"><button className="secondary-button" onClick={() => setDeleting(null)}>Keep room</button><button className="danger-button" disabled={busy} onClick={remove}>{busy ? 'Removing…' : 'Remove room'}</button></div></div></div>}
    {revokingDevice && <div className="modal-backdrop confirm-backdrop"><div className="dialog confirm-dialog"><div className="dialog-icon danger-icon"><Trash2 size={22}/></div><h2>Remove {revokingDevice.name}?</h2><p>This browser will be disconnected and must be assigned again with the administrator PIN. Any call it is on will end.</p><div className="confirm-actions"><button className="secondary-button" onClick={() => setRevokingDevice(null)}>Keep device</button><button className="danger-button" disabled={busy} onClick={revoke}>{busy ? 'Removing…' : 'Remove device'}</button></div></div></div>}
  </div>;
}

export default function App() {
  const app = useIntercom();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [pinAction, setPinAction] = useState<'manage' | 'assign' | null>(null);
  const [pinError, setPinError] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pendingAssignment, setPendingAssignment] = useState<{ name: string; roomId: string } | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const myRoom = app.rooms.find(room => room.id === app.profile?.device.roomId);
  const selectedRoom = app.rooms.find(room => room.id === selectedId) || app.rooms.find(room => room.id !== myRoom?.id) || app.rooms[0];
  const selectedStatus = app.presence.find(item => item.roomId === selectedRoom?.id);
  const onlineRooms = app.presence.filter(item => item.online > 0).length;
  const others = useMemo(() => app.rooms.filter(room => room.id !== myRoom?.id), [app.rooms, myRoom?.id]);
  const shouldSetup = app.loaded && (!app.profile?.device.roomId || !myRoom || setupOpen);
  const canCall = !!app.profile?.device.roomId && app.online && !!selectedStatus?.online && !selectedStatus.busy && selectedRoom?.id !== myRoom?.id && !app.call;
  const openManage = () => { setMobileNav(false); if (app.admin) setManageOpen(true); else { setPinError(''); setPinAction('manage'); } };
  const assign = async (name: string, roomId: string) => {
    if (!app.admin) { setPendingAssignment({ name, roomId }); setPinError(''); setPinAction('assign'); return; }
    try { await app.assign(name, roomId); setSetupOpen(false); }
    catch (cause) { app.setError((cause as Error).message); }
  };
  const submitPin = async (pin: string) => {
    setPinBusy(true); setPinError('');
    try {
      await app.unlock(pin);
      if (pinAction === 'assign' && pendingAssignment) {
        await app.assign(pendingAssignment.name, pendingAssignment.roomId);
        setPendingAssignment(null); setSetupOpen(false);
      } else if (pinAction === 'manage') setManageOpen(true);
      setPinAction(null);
    } catch (cause) { setPinError((cause as Error).message); }
    finally { setPinBusy(false); }
  };
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`} inert={shouldSetup || manageOpen || !!pinAction || !!app.call}>
      <div className="sidebar-brand"><Mark/><div className="brand-name">roomtone<span>.</span></div></div>
      <div className="sidebar-section-label">WORKSPACE</div>
      <nav className="sidebar-nav" aria-label="Main navigation">
        <button className="nav-item active" onClick={() => setMobileNav(false)}><span className="nav-icon"><House size={19}/></span> All rooms <span className="nav-arrow"><ArrowUpRight size={15}/></span></button>
        <button className="nav-item" onClick={() => { setSetupOpen(true); setMobileNav(false); }}><span className="nav-icon"><Headphones size={19}/></span> This device</button>
        <button className="nav-item" onClick={openManage}><span className="nav-icon"><Settings2 size={19}/></span> Manage rooms</button>
      </nav>
      <div className="sidebar-grow"/>
      <div className="sidebar-note"><div className="sidebar-note-icon"><AudioLines size={20}/></div><strong>Closer, in a click.</strong><span>Good conversations start right where you are.</span><div className="sidebar-note-rule"/><small>MADE FOR YOUR SPACE</small></div>
      <div className="sidebar-footer"><span className="footer-dot"/> PRIVATE NETWORK <span className="footer-version">V1.0</span></div>
    </aside>
    {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
    <main className="main" inert={shouldSetup || manageOpen || !!pinAction || !!app.call}>
      <header className="topbar">
        <div className="topbar-left"><button className="mobile-menu icon-button" onClick={() => setMobileNav(true)} aria-label="Open menu"><Menu size={21}/></button><span className="breadcrumb">YOUR SPACE</span><ChevronRight size={14}/><strong>All rooms</strong></div>
        <div className="topbar-right"><span className={`connection-pill ${app.online ? 'connection-online' : ''}`}><span className="pulse-dot"/>{app.online ? 'Connected' : 'Not connected'}</span><button className="device-chip" onClick={() => setSetupOpen(true)} title="Change this device’s assignment"><span className="device-chip-icon"><Headphones size={17}/></span><span>{app.profile?.device.name || 'Set up device'}<small>{myRoom?.name || 'Unassigned'}</small></span><ChevronRight size={15}/></button></div>
      </header>
      <div className="content">
        <div className="hero"><div className="hero-copy"><div className="eyebrow"><span className="eyebrow-rule"/> YOUR PRIVATE INTERCOM</div><h1>Every room,<br/><em>one tap away.</em></h1><p>A little closer, wherever you are. Choose a room to start a conversation.</p></div><div className="hero-art" aria-hidden="true"><div className="hero-art-glow"/><div className="hero-art-ring ring-one"/><div className="hero-art-ring ring-two"/><div className="hero-art-ring ring-three"/><div className="hero-art-core"><Mark/></div><span className="art-coordinate">RT — 001<br/>LOCAL SIGNAL</span></div></div>
        <div className="overview-row"><div className="overview-left"><div className="overview-icon"><Activity size={19}/></div><div><strong>All systems in reach</strong><span>{app.rooms.length} {app.rooms.length === 1 ? 'room' : 'rooms'} in your space · {onlineRooms} online now</span></div></div>{app.profile && !app.alertsEnabled ? <button className="alerts-button" onClick={() => void app.enableAlerts()}><AudioLines size={16}/> Enable ring sound</button> : <span className="overview-meta"><Wifi size={15}/> LOCAL NETWORK</span>}</div>
        <div className="section-heading"><div><div className="eyebrow">THE DIRECTORY / 01</div><h2>Your rooms<span className="heading-count">{app.rooms.length.toString().padStart(2, '0')}</span></h2></div><button className="subtle-button" onClick={openManage}><Plus size={17}/> Manage rooms</button></div>
        {app.rooms.length === 0 ? <div className="empty-state"><div className="empty-icon"><House size={30}/></div><h3>A space to start with.</h3><p>Add your first room to give your devices a place to connect.</p><button className="primary-button" onClick={openManage}>Create a room <ArrowRight size={18}/></button></div> :
        <div className="directory-layout">
          <div className="room-grid">{app.rooms.map((room, index) => {
            const status = app.presence.find(item => item.roomId === room.id);
            const isMine = myRoom?.id === room.id;
            const isSelected = selectedRoom?.id === room.id;
            return <button className={`room-card ${isSelected ? 'room-card-selected' : ''}`} key={room.id} onClick={() => setSelectedId(room.id)}>
              <div className="card-top"><RoomIcon room={room} index={index}/><span className="room-index">{String(index + 1).padStart(2, '0')} / {String(app.rooms.length).padStart(2, '0')}</span></div>
              <div className="card-middle"><span className="room-area">{room.area}</span><h3>{room.name}</h3></div>
              <div className="card-bottom"><Status status={status} count/>{isMine ? <span className="my-room-tag">YOUR ROOM</span> : <span className="card-arrow"><ArrowUpRight size={18}/></span>}</div>
            </button>;
          })}</div>
          {selectedRoom && <div className="detail-panel"><div className="detail-top"><div className="eyebrow">ROOM DETAILS / {String(app.rooms.indexOf(selectedRoom) + 1).padStart(2, '0')}</div><Status status={selectedStatus}/></div>
            <div className="detail-illustration"><div className="detail-ring detail-ring-outer"/><div className="detail-ring detail-ring-inner"/><div className="detail-center"><RoomIcon room={selectedRoom} index={app.rooms.indexOf(selectedRoom)}/></div><span className="detail-cross detail-cross-one">+</span><span className="detail-cross detail-cross-two">+</span></div>
            <div className="detail-copy"><span>{selectedRoom.area.toUpperCase()}</span><h3>{selectedRoom.name}</h3><p>{selectedRoom.id === myRoom?.id ? 'This is where your device belongs. Choose another room to place a call.' : selectedStatus?.busy ? 'This room is on another call right now.' : !selectedStatus?.online ? 'No devices are connected in this room yet.' : 'Ready when you are. Pick how you’d like to connect.'}</p></div>
            <div className="detail-actions"><button className="primary-button" disabled={!canCall} onClick={() => app.startCall(selectedRoom, 'audio')}><Phone size={18} fill="currentColor"/> Voice call</button><button className="secondary-button" disabled={!canCall} onClick={() => app.startCall(selectedRoom, 'video')}><Video size={19}/> Video call</button></div>
            <div className="detail-foot"><Shield size={15}/> Encrypted, direct connection</div>
          </div>}
        </div>}
        <div className="bottom-row"><div className="bottom-line"/><span><Mark small/> THE SOUND OF BEING THERE</span><span>{others.length} OTHER {others.length === 1 ? 'ROOM' : 'ROOMS'} IN REACH</span></div>
      </div>
    </main>
    {app.error && <div className="toast" role="alert"><div className="toast-icon"><WifiOff size={18}/></div><span>{app.error}</span><button onClick={() => app.setError('')} aria-label="Dismiss message"><X size={17}/></button></div>}
    {shouldSetup && <DeviceSetup app={app} onAssign={assign} onManage={openManage} onClose={() => setSetupOpen(false)} inactive={manageOpen || !!pinAction || !!app.call}/>}
    {manageOpen && <ManagePanel app={app} onClose={() => setManageOpen(false)}/>}
    {pinAction && <PinModal onClose={() => { setPinAction(null); setPendingAssignment(null); }} onSubmit={submitPin} busy={pinBusy} error={pinError}/>}
    {app.call && <CallLayer app={app}/>}
  </div>;
}
