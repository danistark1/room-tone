# Roomtone — LAN intercom implementation plan

## Product and assumptions
A self-hosted, browser-based LAN intercom. An administrator defines rooms; a device joins one room; the assigned device calls another room by voice or video, and a person at the target room answers to start a two-way conversation. The user confirmed that multiple devices may join a room: a call rings all available devices and the first answer wins. Other calls to a busy room are rejected. Room management **and assigning/changing a device's room** require an administrator PIN. After assignment, the device may place calls without a login.

## Architecture
- Vite/React/TypeScript client. WebSocket for presence, ringing and WebRTC offer/answer/ICE signaling. WebRTC peer-to-peer audio/video, never relayed through a cloud service. Host-only ICE candidates by default; no STUN/TURN or external dependencies at runtime. Network isolation between Wi-Fi clients or different VLANs can prevent direct media, so this is scoped to a peer-reachable LAN.
- Node/Express and `ws` server in a single container. Atomic JSON persistence at `/data/state.json` for room definitions and device assignments. Ephemeral presence, sessions and calls live in process memory. Room deletion clears orphaned assignments and terminates affected calls.
- A Caddy sidecar terminates HTTPS with its internal CA; the LAN IP address is set through `LAN_HOST`. Every client must explicitly trust the exported Caddy root certificate. Browser permission is requested on call initiation/answer, not simply on page load. HTTP on localhost remains possible for development.
- Admin PIN set at deployment; short-lived in-memory admin sessions via secure HTTP-only cookies. Devices receive a private browser token on enrollment; both enrollment and room assignment require the admin PIN. Administrators can inspect and revoke registered devices. No recording, remote cloud account, push notifications, or background calls.

## Project structure
- `src/`: responsive React UI, room roster, device onboarding, admin management and call experience; `src/useIntercom.ts` owns socket and WebRTC call state.
- `server/`: Express API, persisted room/device store and WebSocket call coordinator.
- `public/`: app icons and static route metadata.
- `tests/`: backend API and signaling integration checks.
- `Dockerfile`, `compose.yaml`, `Caddyfile`: reproducible LAN deployment.

## Visual direction
- **Design movement:** contemporary audio hardware / quiet-control-room interface, editorial rather than gamer-like.
- **Core principles:** instant status comprehension; generous dark negative space; deliberate restraint; prominent tactile calling controls.
- **Color philosophy:** ink-black/navy surfaces and soft warm-white text, punctuated by a vivid chartreuse signal color for availability and live activity. Coral is reserved for ending a call or failure.
- **Layout paradigm:** narrow utility rail plus a fluid primary canvas, with asymmetric title and room composition; on narrow screens it compresses into a top identity strip and a thumb-friendly bottom action zone.
- **Signature elements:** a striped signal glyph/logotype; softly illuminated status pips; oversized room labels and a waveform-like active-call visualization.
- **Interaction and animation:** precise hover elevation, quiet 150–250ms panel transitions, pulsing live signal only during ringing/calls; reduced-motion mode disables nonessential movement.
- **Typography:** locally bundled DM Sans variable for text and display; small uppercase tracked labels and tabular numerals for utility metadata.
- **Brand essence:** Roomtone makes every room one tap away — calm, dependable, immediate.
- **Brand voice:** short and useful. Examples: “Your room is on the line.” “Choose a room to connect.”
- **Wordmark / color:** four offset vertical signal bars beside an editorial ROOMTONE wordmark; ownable lime `#D9FA6B`.

## Constraints
The app is for local networks, but browser security still requires trusted HTTPS on any LAN host other than localhost. Caddy internal CA needs trust installation on each device; iOS additionally needs full trust enabled. Media requires browser permissions and an open active tab (mobile OS backgrounding may interrupt a call). Local network client isolation, restrictive firewalls, browser differences and untrusted certificates are not solved by the app. The server is one process/one LAN host, not a clustered service.
