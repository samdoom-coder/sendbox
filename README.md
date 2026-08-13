# SendBox

A self-hosted, Send-Anywhere-style file sharing app. Upload files, get a link,
share it, and the files auto-delete when the link expires or the download limit
is reached.

Built with Python + FastAPI. No database — shares live in `shares.json` and
files in `storage/`.

## Features

- Drag & drop multi-file upload with progress bar
- Short share link: `https://yourhost/r/<token>` (mobile-friendly download page)
- Per-share expiry (1h – 7 days, or never) and max download count
- Individual file downloads + "Download all as .zip" (streamed, works with GBs)
- Files are deleted automatically when expired / limit hit (cleanup runs every 5 min)
- Filenames sanitized (no path traversal); random hard-to-guess share tokens
- **P2P direct transfer** (`/p2p`): files go straight device-to-device over an
  encrypted WebRTC data channel — the server only relays connection setup
  (signaling), so there is **no size limit** and nothing is stored on the server

## Quick start

```bash
pip install -r requirements.txt
python app.py                # serves on 0.0.0.0:8000
python app.py --port 9000    # custom port
```

Open `http://localhost:8000`, drop files, copy the link, send it.

> Note: both individual file downloads and "Download all as .zip" count toward
> "max downloads". The download-limit counter is stored on disk, so it also
> works across restarts and multiple server workers.

## Project layout

```
sendbox/
  app.py            # FastAPI app + all routes
  templates/        # index.html (upload), receive.html (download)
  static/           # style.css, app.js
  storage/          # uploaded files (created at runtime)
  shares.json       # share metadata (created at runtime)
```

## Going public — what you need

**Local network only** (same Wi-Fi, no friends outside your house):
- Just run it. Friends use `http://<your-LAN-IP>:8000` (find it with `ip addr`
  or `hostname -I`). Allow port 8000 in your firewall if needed.

**Anywhere on the internet** — pick one:

| Option | Cost | Needs | Notes |
|---|---|---|---|
| VPS + Caddy | ~$5/mo VPS | A small Linux box (e.g. a $5 DigitalOcean/Hetzner droplet) + a domain | `pip install ...`, `caddy reverse-proxy` gives you HTTPS automatically. Most robust, always-on. |
| Cloudflare Tunnel | Free | A domain + `cloudflared` on your home machine | No open ports / no port forwarding. HTTPS auto. Tunnel to port 8000. |
| Tailscale | Free (personal) | Tailscale installed on your + friends' devices | Private — only people in your tailnet reach it. No public internet. |
| ngrok | Free tier | ngrok installed | Instant public URL (`ngrok http 8000`), URL changes each run on free tier. Good for quick demos. |
| Render / Railway / Fly.io | Free tiers | Git push | Easy, but free tiers have ephemeral disk — uploads are lost on redeploy/restart. Only suitable for small/throwaway sharing. |

**Practical minimum for real use:** a cheap always-on VPS (~$5/mo) with Caddy
for HTTPS, or Cloudflare Tunnel on the PC you already leave running. Storage on
disk must be large enough for the files you plan to share.

## Hardening notes (if you open it to the internet)

- Put it behind HTTPS (Caddy / Cloudflare / Tailscale serve). Never expose raw
  HTTP with sensitive files.
- Optionally add HTTP Basic Auth in your reverse proxy to keep uploads private.
- The current version has no per-user accounts; anyone with the link can download
  until it expires. For extra privacy, prefer a short expiry.

## Deploying on Render (free tier)

**Start command:** `uvicorn app:app --host 0.0.0.0 --port 10000` (or `python app.py --port 10000`).

**Keep-alive (prevent sleeping):** Render free instances spin down after 15
minutes of inactivity. SendBox self-pings when it's hosted on Render:
`RENDER_EXTERNAL_URL` is set automatically, and the app then pings its own
`/api/ping` endpoint every 10 minutes so it stays warm. Tune with
`PING_INTERVAL_SECONDS` (minimum 60).

**Download limits that survive sleep/restarts:** share metadata (including the
download counter) lives in `shares.json`, which is read from disk on every
request and updated atomically with a cross-process file lock. Limits keep
working across multiple workers and after the instance restarts.

**Filesystem caveat — important:** Render's free tier has an *ephemeral* disk.
Uploaded files, `shares.json`, and download counters are wiped whenever the
instance restarts, is redeployed, or moves machines. This is why limits (and
files) may reset after a sleep on Render but not locally. To make uploads and
counters durable on Render:

- Add Render's paid **Persistent Disk** add-on (from ~$7/mo) and set the env var
  `SENDBOX_DATA_DIR` to its mount path (e.g. `/var/data`). Files and limits then
  survive restarts and redeploys.

**Env vars:**

| Variable | Default | Purpose |
|---|---|---|
| `RENDER_EXTERNAL_URL` | (auto-set by Render) | Enables the keep-alive self-ping |
| `PING_INTERVAL_SECONDS` | 600 | Seconds between keep-alive pings (min 60) |
| `SENDBOX_DATA_DIR` | project dir | Where `storage/` and `shares.json` live — point at a persistent disk |

## Peer-to-peer (P2P) transfer

Open `/p2p` (there's a "P2P direct" toggle on the home page). The person sending
creates a session and shares the link/code; the receiver opens it. Files then
flow **directly between the two devices** over a WebRTC data channel — no size
limit, nothing uploaded to or stored on the server.

- Uses public Google STUN for NAT traversal, so it usually works across
  different networks. If direct connections fail behind strict/symmetric NATs,
  set a TURN server via the `P2P_ICE_SERVERS` env var (JSON array of ICE server
  objects), e.g.:
  `P2P_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your-turn.example:3478","username":"u","credential":"p"}]'`
- Signaling rooms live in process memory, so run a **single server worker**
  (`python app.py` or `uvicorn app:app`) for P2P to work — the standard
  upload/link-sharing flow still works fine with multiple workers.
- Both devices must keep their tab open until the transfer completes.

