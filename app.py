import argparse
import asyncio
import json
import mimetypes
import os
import secrets
import shutil
import threading
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import uvicorn
import zipstream
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

try:
    import fcntl
except ImportError:  # Windows fallback
    fcntl = None

BASE_DIR = Path(__file__).resolve().parent
# Point SENDBOX_DATA_DIR at a persistent disk mount so uploads + limits survive
# restarts (Render free ephemeral disk is wiped on sleep/redeploy).
DATA_DIR = Path(os.environ.get("SENDBOX_DATA_DIR", BASE_DIR))
STORAGE_DIR = DATA_DIR / "storage"
DATA_FILE = DATA_DIR / "shares.json"

_thread_lock = threading.Lock()

DEFAULT_EXPIRES_HOURS = 24
MAX_FILENAME_LEN = 150
CLEANUP_INTERVAL = 300
# Render free instances sleep after 15 min of inactivity. RENDER_EXTERNAL_URL is
# set automatically by Render; when present we self-ping to stay awake.
RENDER_URL = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")

# ---------- P2P (peer-to-peer) direct transfer ----------
# The server only relays WebRTC signaling (SDP + ICE) and never stores files.
# Use public STUN for NAT traversal; add TURN via P2P_ICE_SERVERS if you need
# reliable connections through symmetric NATs.
DEFAULT_ICE_SERVERS = [{"urls": "stun:stun.l.google.com:19302"}]
ICE_SERVERS = json.loads(os.environ.get("P2P_ICE_SERVERS", json.dumps(DEFAULT_ICE_SERVERS)))
MAX_P2P_PEERS = 2
P2P_ROOMS = {}  # room -> {peer_id: WebSocket} (single-worker in-memory signaling)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------- persistent, atomic, multi-process-safe share store ----------
# shares.json on disk is the single source of truth (not memory), so download
# limits keep working across worker restarts / multiple gunicorn workers.


def _acquire():
    """Cross-process lock (fcntl) with threading fallback for Windows."""
    if fcntl is None:
        _thread_lock.acquire()
        return None
    f = open(DATA_FILE.with_suffix(".lock"), "a+")
    fcntl.flock(f.fileno(), fcntl.LOCK_EX)
    return f


def _release(f):
    if f is None:
        _thread_lock.release()
        return
    fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    f.close()


def _read_locked():
    try:
        return json.loads(DATA_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_locked(shares):
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(shares, indent=2))
    os.replace(tmp, DATA_FILE)


def read_shares():
    f = _acquire()
    try:
        return _read_locked()
    finally:
        _release(f)


def write_shares(shares):
    f = _acquire()
    try:
        _write_locked(shares)
    finally:
        _release(f)


def _expired(share):
    exp = share.get("expires")
    return bool(exp) and exp <= now_iso()


def _over_limit(share):
    max_d = share.get("max_downloads")
    return bool(max_d) and share.get("downloads", 0) >= max_d


def get_share(token):
    share = read_shares().get(token)
    if not share or _expired(share) or _over_limit(share):
        return None
    return share


def _purge_share_data(shares, token):
    share = shares.pop(token, None)
    if share:
        dir_path = STORAGE_DIR / token
        if dir_path.exists():
            shutil.rmtree(dir_path, ignore_errors=True)


def cleanup_expired():
    f = _acquire()
    try:
        shares = _read_locked()
        changed = False
        for token in list(shares.keys()):
            if _expired(shares[token]) or _over_limit(shares[token]):
                _purge_share_data(shares, token)
                changed = True
        if changed:
            _write_locked(shares)
    finally:
        _release(f)


async def cleanup_loop():
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL)
        try:
            cleanup_expired()
        except Exception:
            pass


# ---------- keep-alive for Render free tier ----------
async def keepalive_loop():
    if not RENDER_URL:
        return
    interval = max(60, int(os.environ.get("PING_INTERVAL_SECONDS", 600)))
    url = f"{RENDER_URL}/api/ping"
    while True:
        await asyncio.sleep(interval)
        try:
            await asyncio.to_thread(urllib.request.urlopen, url, timeout=10)
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app):
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_expired()
    tasks = [asyncio.create_task(cleanup_loop())]
    if RENDER_URL:
        tasks.append(asyncio.create_task(keepalive_loop()))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="SendBox", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def safe_filename(name):
    name = os.path.basename(name.replace("\\", "/"))
    name = "".join(c for c in name if c not in "\x00\r\n\t")
    name = name.strip().strip(".")
    if not name:
        name = "file"
    if len(name) > MAX_FILENAME_LEN:
        root, ext = os.path.splitext(name)
        name = root[: MAX_FILENAME_LEN - len(ext)] + ext
    return name


@app.get("/api/ping")
async def ping():
    return {"ok": True, "time": now_iso()}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html", {})


@app.get("/p2p", response_class=HTMLResponse)
async def p2p_page(request: Request):
    return templates.TemplateResponse(request, "p2p.html", {"ice_servers": ICE_SERVERS})


@app.websocket("/ws/{room}")
async def p2p_signal(websocket: WebSocket, room: str):
    """Relay WebRTC signaling (SDP/ICE) between the two peers in a room."""
    room = room[:64]
    peer_id = websocket.query_params.get("peer", "")[:64] or uuid.uuid4().hex[:12]
    await websocket.accept()
    peers = P2P_ROOMS.setdefault(room, {})
    if len(peers) >= MAX_P2P_PEERS:
        await websocket.send_json({"type": "error", "message": "room-full"})
        await websocket.close()
        return
    peers[peer_id] = websocket
    peer_list = list(peers.keys())
    try:
        await websocket.send_json({"type": "room-state", "peerId": peer_id, "peers": peer_list})
        for pid, sock in list(peers.items()):
            if pid != peer_id:
                try:
                    await sock.send_json({"type": "peer-joined", "peerId": peer_id, "peers": peer_list})
                except Exception:
                    pass
        while True:
            data = await websocket.receive_json()
            data["from"] = peer_id
            target = data.get("to")
            if target and target in peers:
                await peers[target].send_json(data)
            else:
                for pid, sock in list(peers.items()):
                    if pid != peer_id:
                        try:
                            await sock.send_json(data)
                        except Exception:
                            pass
    except WebSocketDisconnect:
        pass
    finally:
        if peer_id in peers:
            del peers[peer_id]
        if not peers:
            P2P_ROOMS.pop(room, None)
        else:
            for pid, sock in list(peers.items()):
                try:
                    await sock.send_json({"type": "peer-left", "peerId": peer_id})
                except Exception:
                    pass


@app.get("/r/{token}", response_class=HTMLResponse)
async def receive(request: Request, token: str):
    share = get_share(token)
    if not share:
        return templates.TemplateResponse(request, "receive.html", {"error": True, "token": token})
    total = sum(f["size"] for f in share["files"])
    return templates.TemplateResponse(
        request,
        "receive.html",
        {
            "error": False,
            "token": token,
            "files": share["files"],
            "total_size": total,
            "expires": share.get("expires"),
            "expired_label": share.get("expired_label", "link is no longer valid"),
        },
    )


@app.post("/api/upload")
async def upload(
    files: list[UploadFile] = File(...),
    expires_hours: str = Form(""),
    max_downloads: str = Form(""),
):
    if not files or all(f.filename == "" for f in files):
        raise HTTPException(400, "No files selected")

    token = secrets.token_urlsafe(6).replace("-", "_")
    share_dir = STORAGE_DIR / token
    share_dir.mkdir(parents=True, exist_ok=True)

    try:
        expires_h = int(expires_hours) if expires_hours.strip() else DEFAULT_EXPIRES_HOURS
    except ValueError:
        expires_h = DEFAULT_EXPIRES_HOURS
    if expires_h <= 0:
        expires_h = None

    try:
        max_d = int(max_downloads) if max_downloads.strip() else None
    except ValueError:
        max_d = None
    if max_d is not None and max_d <= 0:
        max_d = None

    stored = []
    for f in files:
        if not f.filename:
            continue
        name = safe_filename(f.filename)
        fid = uuid.uuid4().hex[:12]
        dest = share_dir / f"{fid}_{name}"
        size = 0
        with open(dest, "wb") as out:
            while chunk := await f.read(1024 * 1024):
                out.write(chunk)
                size += len(chunk)
        stored.append({"id": fid, "name": name, "size": size, "path": str(dest)})

    if not stored:
        shutil.rmtree(share_dir, ignore_errors=True)
        raise HTTPException(400, "No valid files")

    share = {
        "token": token,
        "created": now_iso(),
        "expires": _expire_iso(expires_h),
        "max_downloads": max_d,
        "downloads": 0,
        "files": stored,
    }
    shares = read_shares()
    shares[token] = share
    write_shares(shares)
    return {"token": token}


def _expire_iso(hours):
    if not hours:
        return ""
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


@app.get("/api/share/{token}/files/{fid}")
async def download_file(token: str, fid: str):
    f = _acquire()
    try:
        shares = _read_locked()
        share = shares.get(token)
        if not share:
            raise HTTPException(410, "Share expired or not found")
        if _expired(share) or _over_limit(share):
            raise HTTPException(410, "Share expired or not found")
        file_info = next((x for x in share["files"] if x["id"] == fid), None)
        if not file_info:
            raise HTTPException(404, "File not found")
        path = Path(file_info["path"])
        if not path.exists():
            raise HTTPException(404, "File missing on disk")
        share["downloads"] = share.get("downloads", 0) + 1
        _write_locked(shares)
    finally:
        _release(f)
    return FileResponse(
        path,
        media_type=mimetypes.guess_type(file_info["name"])[0] or "application/octet-stream",
        filename=file_info["name"],
    )


@app.get("/api/share/{token}/zip")
async def download_all(token: str):
    f = _acquire()
    try:
        shares = _read_locked()
        share = shares.get(token)
        if not share:
            raise HTTPException(410, "Share expired or not found")
        if _expired(share) or _over_limit(share):
            raise HTTPException(410, "Share expired or not found")
        share["downloads"] = share.get("downloads", 0) + 1
        _write_locked(shares)
        files = list(share["files"])
    finally:
        _release(f)

    def gen():
        z = zipstream.ZipStream(compress_type=zipstream.ZIP_DEFLATED)
        for info in files:
            p = Path(info["path"])
            if p.exists():
                z.add_path(p, arcname=info["name"])
        for chunk in z:
            yield chunk

    return StreamingResponse(
        gen(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="sendbox-{token}.zip"'},
    )


def main():
    parser = argparse.ArgumentParser(description="SendBox - personal file sharing")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    print(f"SendBox running at http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()