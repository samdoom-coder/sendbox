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

## Quick start

```bash
pip install -r requirements.txt
python app.py                # serves on 0.0.0.0:8000
python app.py --port 9000    # custom port
```

Open `http://localhost:8000`, drop files, copy the link, send it.

> Note: the zip download and the receive page do not count toward "max downloads"
> (only individual file downloads do).

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
