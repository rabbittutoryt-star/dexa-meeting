# DEXA Meeting

## Custom control icons

- Screen Share now uses the supplied icon in `public/assets/screenshare.png`.
- The microphone button uses 🎙️ and overlays a diagonal cut line while muted.

## Python backend

DEXA Meeting is a working small-room WebRTC web app. Its backend is now written entirely in **Python** and uses only the Python standard library—there is no Node.js, npm, Flask, Django, FastAPI, or pip dependency.

## Features

- signup and login restricted to `@dexa.online`
- password hashing with Python `hashlib.scrypt`
- signed, HTTP-only multi-account session cookies
- add multiple signed-in accounts in one browser
- switch accounts from the profile-logo menu
- edit display name and upload, change, or remove a profile picture
- profile bar shown inside the meeting side panel with edit and account-management shortcuts
- customization tabs remain fixed directly below the profile bar without overlapping the style/background box
- case-insensitive unique-email protection
- live camera and microphone through WebRTC
- peer-to-peer video rooms and signaling
- screen sharing
- reactions and meeting chat
- participant list with microphone/camera state
- background blur, built-in virtual backgrounds, and uploaded backgrounds
- background effects run from the packaged browser code and do not depend on a third-party CDN
- responsive desktop/mobile interface using the supplied DEXA Meeting logo

## Run on Windows

1. Install **Python 3.10 or newer** once. During installation, enable **Add Python to PATH**.
2. Extract this ZIP.
3. Double-click `start.bat`.
4. The app opens at `http://localhost:3000`.
5. Create an account such as `yourname@dexa.online`.

No `pip install` command is needed.

## Run from a terminal

Windows:

```bat
copy .env.example .env
python server.py
```

Linux/macOS:

```bash
cp .env.example .env
python3 server.py
```

## Test a live meeting

1. Start the Python server.
2. Create two different `@dexa.online` accounts in two browser profiles or devices.
3. Start a meeting on the first device.
4. Enter its meeting code on the second device.
5. Allow camera and microphone access in both browsers.

Use headphones when testing two participants on the same computer to avoid audio feedback.

## Backend design

`server.py` provides:

- JSON REST endpoints for registration, login, current-user checks, account switching, and current/all-account logout
- profile editing and validated local avatar uploads in `public/uploads/avatars/`
- in-memory meeting rooms and participant presence
- WebRTC offer, answer, and ICE-candidate signaling
- short-poll event delivery used by the existing frontend
- chat, reactions, media-state broadcasts, and stale-session cleanup
- static delivery of the frontend in `public/`

Existing `data/users.json` accounts from the Node version remain compatible because both versions use the same scrypt parameters and hash encoding.

## Online deployment

A public camera/microphone deployment must use **HTTPS**. Copy `.env.example` to `.env` and change at least:

```env
APP_ENV=production
PORT=3000
JWT_SECRET=replace-with-a-long-random-secret
APP_ORIGIN=https://meet.your-domain.com
```

For calls across strict NAT, mobile networks, or corporate firewalls, configure a TURN server:

```env
TURN_URL=turn:turn.your-domain.com:3478,turns:turn.your-domain.com:5349
TURN_USERNAME=your-turn-user
TURN_CREDENTIAL=your-turn-password
```

The included standard-library HTTP server is suitable for local use, demos, and small controlled deployments. For a public production service, place it behind a TLS reverse proxy such as Caddy or Nginx. For higher traffic, keep the frontend but move authentication and signaling behind a production-grade Python deployment architecture and a durable database.

## Realistic meeting capacity

This version uses a **WebRTC mesh**. Each participant sends media to every other participant, so the room is capped at 8 users by default. Zoom-scale rooms, cloud recording, host moderation, waiting rooms, and hundreds of viewers require an SFU such as LiveKit, mediasoup, or Jitsi.

`@dexa.online` addresses are app account names only. They do not create real email inboxes. Real email verification and password resets require domain DNS and an email provider.

## Project structure

```text
server.py                  Python authentication, signaling, and HTTP server
public/index.html          Interface
public/styles.css          Responsive design
public/app.js              WebRTC, controls, chat, reactions, backgrounds
public/assets/             DEXA logo
data/users.json            Local account store
.env.example               Deployment settings
start.bat / start.sh       Launchers
Dockerfile                 Optional Python container deployment
requirements.txt           Confirms no third-party packages are needed
```


## Meeting preview position

The lobby meeting preview card is placed directly below the New meeting / meeting-code controls, including responsive layouts.

## Live chat reliability update
- Chat sends now wait for a server acknowledgement before clearing the message box.
- The sender sees the confirmed message immediately.
- Other participants receive queued room events through dependency-free long polling, so messages arrive as soon as the server receives them instead of waiting on a fixed refresh interval.
- Duplicate self-messages are prevented by message ID.
- If a send fails during a reconnect, the typed message remains available to retry.
