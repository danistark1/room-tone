export type Room = { id: string; name: string; area: string };
export type Presence = { roomId: string; online: number; alerts: number; busy: boolean };
export type Device = { id: string; name: string; roomId: string | null };
export type AdminDevice = Device & { online: boolean; alerts: boolean; updatedAt: string | null };
export type Profile = { device: Device; token: string };
export type Mode = 'audio' | 'video';
export type Call = {
  id: string;
  phase: 'preparing' | 'ringing' | 'connecting' | 'connected';
  direction: 'incoming' | 'outgoing';
  mode: Mode;
  peerRoom: Room;
  peerDevice?: string;
  muted: boolean;
  cameraOff: boolean;
  startedAt?: number;
};
