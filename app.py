import argparse
import asyncio
import json
import mimetypes
import os
import secrets
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
import zipstream
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent
STORAGE_DIR = BASE_DIR / "storage"
DATA_FILE = BASE_DIR / "shares.json"

_lock = threading.Lock()
_shares = {}

DEFAULT_EXPIRES_HOURS = 24
MAX_FILENAME_LEN = 150


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_shares():
    global _shares
    with _lock:
        if DATA_FILE.exists():
            try:
                _shares = json.loads(DATA_FILE.read_text())
            except json.JSONDecodeError:
                _shares = {}
        else:
            _shares = {}


def save_shares():
    with _lock:
        DATA_FILE.write_text(json.dumps(_shares, indent=2))


def get_share(token):
    share = _shares.get(token)
    if not share:
        return None
    if share.get("expires") and share["expires"] <= now_iso():
        return None
    if share.get("max_downloads") and share.get("downloads", 0) >= share["max_downloads"]:
        return None
    return share


def purge_share(token):
    share = _shares.pop(token, None)
    if share:
        dir_path = STORAGE_DIR / token
        if dir_path.exists():
            shutil.rmtree(dir_path, ignore_errors=True)
    save_shares()


def cleanup_expired():
    for token in list(_shares.keys()):
        share = get_share(token)
        if share is None:
            purge_share(token)


async def cleanup_loop():
    while True:
        await asyncio.sleep(300)
        try:
            cleanup_expired()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app):
    STORAGE_DIR.mkdir(exist_ok=True)
    load_shares()
    cleanup_expired()
    task = asyncio.create_task(cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="SendBox", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def safe_filename(name):
    name = os.path.basename(name.replace("\\", "/"))
    name = "".join(c for c in name if c not in '\x00\r\n\t')
    name = name.strip().strip(".")
    if not name:
        name = "file"
    if len(name) > MAX_FILENAME_LEN:
        root, ext = os.path.splitext(name)
        name = root[: MAX_FILENAME_LEN - len(ext)] + ext
    return name


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html", {})


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
    _shares[token] = share
    save_shares()
    return {"token": token}


def _expire_iso(hours):
    from datetime import timedelta

    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _bump_downloads(token):
    share = _shares.get(token)
    if not share:
        return
    share["downloads"] = share.get("downloads", 0) + 1
    save_shares()


@app.get("/api/share/{token}/files/{fid}")
async def download_file(token: str, fid: str):
    share = get_share(token)
    if not share:
        raise HTTPException(410, "Share expired or not found")
    f = next((x for x in share["files"] if x["id"] == fid), None)
    if not f:
        raise HTTPException(404, "File not found")
    path = Path(f["path"])
    if not path.exists():
        raise HTTPException(404, "File missing on disk")
    _bump_downloads(token)
    return FileResponse(
        path,
        media_type=mimetypes.guess_type(f["name"])[0] or "application/octet-stream",
        filename=f["name"],
    )


@app.get("/api/share/{token}/zip")
async def download_all(token: str):
    share = get_share(token)
    if not share:
        raise HTTPException(410, "Share expired or not found")

    def gen():
        z = zipstream.ZipStream(compress_type=zipstream.ZIP_DEFLATED)
        for f in share["files"]:
            p = Path(f["path"])
            if p.exists():
                z.add_path(p, arcname=f["name"])
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
