"""Upload endpoint for Handover episodes, meant to run as a free Hugging Face Space.

The game POSTs finished episodes (gzipped JSON Lines, one episode per line, the format of
web/src/recorder.js) to /episodes. Each episode is checked, then saved as its own file in a
local folder that huggingface_hub's CommitScheduler pushes to a dataset repo every few
minutes. The upload token lives only in the Space's secrets, never in the game.

Privacy: the server never writes IP addresses anywhere. It keeps them in memory only, for
the per-address rate limit, and forgets them after an hour.

Settings (Space variables and secrets):
  HF_TOKEN         secret, a fine-grained token with write access to DATASET_REPO only
  DATASET_REPO     e.g. "suavi-yildirim/handover-episodes" (created private if missing)
  ALLOWED_ORIGINS  comma-separated origins allowed to upload, default "*"
  DATA_DIR         local staging folder, default /tmp/handover-episodes
Without HF_TOKEN and DATASET_REPO the server only saves to DATA_DIR (local testing).
"""
import gzip
import json
import math
import os
import re
import time
import zlib
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

DATASET_REPO = os.environ.get("DATASET_REPO", "").strip()
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/handover-episodes"))
PUSH_EVERY_MIN = 5

MAX_BODY = 8 * 1024 * 1024  # bytes as sent (gzipped); a 15 s episode is about 50 KB
MAX_RAW = 64 * 1024 * 1024  # bytes after gunzip, so a small "zip bomb" can't fill memory
MAX_EPISODES = 50  # per upload
MAX_FRAMES = 30 * 60 * 20  # 20 minutes at 30 fps
RATE_LIMIT = 120  # uploads per address per hour

FORMAT_VERSIONS = {1}
LICENSE = "CC-BY-4.0"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
VERSION = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}$")
NAME = re.compile(r"^[a-z0-9_]{1,40}$")

app = FastAPI(title="Handover episode upload", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET", "POST"],
                   allow_headers=["Content-Type"], max_age=3600)

DATA_DIR.mkdir(parents=True, exist_ok=True)
scheduler = None
if HF_TOKEN and DATASET_REPO:
    from huggingface_hub import CommitScheduler
    # Private by default: Suavi publishes reviewed releases, and removal requests stay possible.
    scheduler = CommitScheduler(repo_id=DATASET_REPO, repo_type="dataset", folder_path=DATA_DIR,
                                path_in_repo="raw", every=PUSH_EVERY_MIN, private=True, token=HF_TOKEN)

_recent = defaultdict(deque)  # address -> upload times in the last hour, memory only


def _client(request: Request) -> str:
    # uvicorn's --proxy-headers (see Dockerfile) puts the player's address here behind the Space proxy.
    return request.client.host if request.client else "?"


def _rate_limited(addr: str, now: float) -> bool:
    q = _recent[addr]
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= RATE_LIMIT:
        return True
    q.append(now)
    return False


def _numbers(rows, width=None) -> bool:
    for r in rows:
        if not isinstance(r, list) or (width is not None and len(r) != width):
            return False
        for x in r:
            if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
                return False
    return True


def check_episode(ep) -> str | None:
    """Returns why an episode is rejected, or None if it is fine."""
    if not isinstance(ep, dict):
        return "an episode is not a JSON object"
    if ep.get("format") != "handover-episode" or ep.get("version") not in FORMAT_VERSIONS:
        return "not a Handover episode in a known format version"
    if ep.get("license") != LICENSE:
        return f"episodes must carry license {LICENSE}"
    if not isinstance(ep.get("episode_id"), str) or not UUID.match(ep["episode_id"]):
        return "episode_id must be a UUID"
    cid = ep.get("contributor_id")
    if cid is not None and (not isinstance(cid, str) or not UUID.match(cid)):
        return "contributor_id must be a UUID or null"
    if not isinstance(ep.get("game_version"), str) or not VERSION.match(ep["game_version"]):
        return "game_version must look like 1.2.3"
    if not isinstance(ep.get("task_id"), str) or not NAME.match(ep["task_id"]):
        return "task_id is missing or invalid"
    if not isinstance(ep.get("success"), bool) or not isinstance(ep.get("score"), (int, float)):
        return "success and score are missing"
    f = ep.get("frames")
    if not isinstance(f, dict) or not all(isinstance(f.get(k), list) for k in ("time", "qpos", "qvel", "ctrl")):
        return "frames must hold time, qpos, qvel and ctrl lists"
    n = len(f["time"])
    if not 1 <= n <= MAX_FRAMES or any(len(f[k]) != n for k in ("qpos", "qvel", "ctrl")):
        return "frame lists are empty, too long, or of different lengths"
    if not _numbers([f["time"]]):
        return "frame times must be numbers"
    for k in ("qpos", "qvel", "ctrl"):
        if not _numbers(f[k], width=len(f[k][0]) if f[k] and isinstance(f[k][0], list) else None):
            return f"frames.{k} must be rows of numbers of one width"
    return None


def _gunzip(body: bytes) -> bytes:
    if body[:2] != b"\x1f\x8b":
        return body  # plain JSON Lines, from browsers without CompressionStream
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        raw = d.decompress(body, MAX_RAW + 1)
    except zlib.error:
        raise HTTPException(400, "the file is not valid gzip")
    if len(raw) > MAX_RAW or d.unconsumed_tail:
        raise HTTPException(413, "the file is too large once unpacked")
    return raw


def _save(ep) -> bool:
    """Writes one episode under DATA_DIR. Returns False if it was already saved (a retry)."""
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path = DATA_DIR / f"game-{ep['game_version']}" / day / f"{ep['episode_id']}.jsonl.gz"
    if any(DATA_DIR.glob(f"game-{ep['game_version']}/*/{ep['episode_id']}.jsonl.gz")):
        return False
    data = gzip.compress((json.dumps(ep, separators=(",", ":")) + "\n").encode())
    path.parent.mkdir(parents=True, exist_ok=True)
    if scheduler is None:
        path.write_bytes(data)
    else:
        with scheduler.lock:  # don't let a push catch a half-written file
            path.write_bytes(data)
    return True


@app.get("/")
def health():
    return {"ok": True, "pushing_to_dataset": scheduler is not None}


@app.post("/episodes")
async def upload(request: Request):
    if _rate_limited(_client(request), time.monotonic()):
        raise HTTPException(429, "too many uploads from this address; try again in an hour")
    if int(request.headers.get("content-length") or 0) > MAX_BODY:
        raise HTTPException(413, "the file is too large")
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY:
            raise HTTPException(413, "the file is too large")
    try:
        lines = _gunzip(bytes(body)).decode("utf-8").splitlines()
    except UnicodeDecodeError:
        raise HTTPException(400, "the file is not UTF-8 text")
    lines = [l for l in lines if l.strip()]
    if not lines:
        raise HTTPException(400, "the file has no episodes")
    if len(lines) > MAX_EPISODES:
        raise HTTPException(413, f"at most {MAX_EPISODES} episodes per upload")
    episodes = []
    for i, line in enumerate(lines, 1):
        try:
            ep = json.loads(line)
        except json.JSONDecodeError:
            raise HTTPException(400, f"episode {i} is not valid JSON")
        why = check_episode(ep)
        if why:
            raise HTTPException(400, f"episode {i}: {why}")
        episodes.append(ep)
    saved = sum(_save(ep) for ep in episodes)  # all checked first, so a bad file saves nothing
    return {"saved": saved, "duplicates": len(episodes) - saved}
