"""Tests for the upload Space, offline: no token, so episodes are only saved to a temp folder.
  pip install -r server/hf_space/requirements.txt httpx
  python server/hf_space/test_app.py
"""
import copy
import gzip
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent.parent / "tests" / "fixtures"
os.environ.pop("HF_TOKEN", None)
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="handover-upload-")
sys.path.insert(0, str(HERE))

import app as server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(server.app)
checks = []


def check(name, ok):
    checks.append((name, bool(ok)))


def post(episodes, gz=True, origin=None):
    body = "".join(json.dumps(e) + "\n" for e in episodes).encode()
    headers = {"Content-Type": "application/gzip" if gz else "application/x-ndjson"}
    if origin:
        headers["Origin"] = origin
    return client.post("/episodes", content=gzip.compress(body) if gz else body, headers=headers)


real = [json.loads(p.read_text().splitlines()[0]) for p in sorted(FIXTURES.glob("*.jsonl"))]
check("three fixture episodes found", len(real) == 3)

r = post(real)
check("real episodes are accepted", r.status_code == 200 and r.json() == {"saved": 3, "duplicates": 0})
saved = sorted(Path(os.environ["DATA_DIR"]).rglob("*.jsonl.gz"))
check("one file per episode, under game version and date", len(saved) == 3 and
      all(p.parent.parent.name == f"game-{real[0]['game_version']}" for p in saved))
back = json.loads(gzip.decompress(saved[0].read_bytes()))
check("saved episode is unchanged", back in real)
check("a retry is counted as a duplicate, not saved twice",
      post(real[:1]).json() == {"saved": 0, "duplicates": 1})
check("plain JSON Lines is accepted too", post([dict(real[0], episode_id="00000000-0000-4000-8000-000000000001")],
                                               gz=False).status_code == 200)


def rejected(name, change, status=400):
    ep = copy.deepcopy(real[0])
    ep["episode_id"] = "00000000-0000-4000-8000-0000000000ff"
    change(ep)
    r = post([ep])
    check(f"rejects {name}", r.status_code == status and "detail" in r.json())


rejected("a different license", lambda e: e.update(license="CC0"))
rejected("a non-UUID episode id", lambda e: e.update(episode_id="../../etc/passwd"))
rejected("a path-like game version", lambda e: e.update(game_version="../0.4.1"))
rejected("an unknown format version", lambda e: e.update(version=99))
rejected("frame lists of different lengths", lambda e: e["frames"]["qpos"].pop())
rejected("non-numeric joint values", lambda e: e["frames"]["qpos"][0].__setitem__(0, "x"))
rejected("ragged qpos rows", lambda e: e["frames"]["qpos"][5].append(0.0))
rejected("a missing success flag", lambda e: e.pop("success"))

ok_then_bad = [dict(real[0], episode_id="00000000-0000-4000-8000-0000000000aa"), {"format": "nope"}]
before = len(list(Path(os.environ["DATA_DIR"]).rglob("*.jsonl.gz")))
check("a file with one bad episode saves nothing", post(ok_then_bad).status_code == 400 and
      len(list(Path(os.environ["DATA_DIR"]).rglob("*.jsonl.gz"))) == before)

check("rejects bytes that are not gzip or JSON", client.post("/episodes", content=b"\x1f\x8bnot gzip").status_code == 400)
check("rejects an empty upload", client.post("/episodes", content=b"").status_code == 400)
bomb = gzip.compress(b"0" * (server.MAX_RAW + 10))
check("rejects a small file that unpacks too large", client.post("/episodes", content=bomb).status_code == 413)
check("rejects a body over the size cap", client.post("/episodes", content=b"x" * (server.MAX_BODY + 1)).status_code == 413)

pre = client.options("/episodes", headers={"Origin": "http://localhost:8000", "Access-Control-Request-Method": "POST",
                                           "Access-Control-Request-Headers": "content-type"})
check("CORS preflight from the game is allowed", pre.status_code == 200 and
      pre.headers.get("access-control-allow-origin") in ("*", "http://localhost:8000"))

check("health says it is not pushing without a token", client.get("/").json() == {"ok": True, "pushing_to_dataset": False})

server._recent.clear()
server.RATE_LIMIT = 3
codes = [client.post("/episodes", content=b"").status_code for _ in range(4)]
check("rate limit answers 429 after the cap", codes[:3] == [400, 400, 400] and codes[3] == 429)
check("no IP address is written to disk", not any(b"testclient" in p.read_bytes() or b"127.0.0.1" in p.read_bytes()
                                                   for p in Path(os.environ["DATA_DIR"]).rglob("*") if p.is_file()))

for name, ok in checks:
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
sys.exit(0 if all(ok for _, ok in checks) else 1)
