"""Fast checks of the raw-episode handling (no rendering, no LeRobot).  pytest training/tests"""

import gzip
import json
from pathlib import Path

import mujoco
import numpy as np
import pytest

from handover_train.scene import model_path
from handover_train.schema import FPS, JOINTS, Units, find_raw, load_episodes, resample, validate_raw

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures"


@pytest.fixture(scope="module")
def model():
    return mujoco.MjModel.from_xml_path(str(model_path("models/kitchen.xml")))


@pytest.fixture(scope="module")
def episodes():
    files = find_raw([FIXTURES])
    assert files, "no fixtures in tests/fixtures"
    return [ep for f in files for ep in load_episodes(f)]


def test_fixtures_are_valid(episodes, model):
    for ep in episodes:
        assert validate_raw(ep, model) == [], ep["task_id"]


def test_reads_json_and_gzipped_jsonl(tmp_path, episodes):
    ep = episodes[0]
    (tmp_path / "one.json").write_text(json.dumps(ep))
    with gzip.open(tmp_path / "many.jsonl.gz", "wt") as f:
        f.write(json.dumps(ep) + "\n" + json.dumps(ep) + "\n")
    files = find_raw([tmp_path])
    assert [len(load_episodes(f)) for f in files] == [2, 1]


def test_rejects_bad_episodes(episodes, model):
    ep = json.loads(json.dumps(episodes[0]))
    ep["frames"]["qpos"][3] = ep["frames"]["qpos"][3][:-1]
    assert validate_raw(ep, model)
    ep = json.loads(json.dumps(episodes[0]))
    ep["frames"]["time"][5:] = [t + 1.0 for t in ep["frames"]["time"][5:]]
    assert any("gap" in e for e in validate_raw(ep, model))
    ep = json.loads(json.dumps(episodes[0]))
    ep["joint_names"] = JOINTS[::-1]
    assert validate_raw(ep, model)


def test_units_round_trip(model):
    units = Units(model)
    rad = np.array([0.3, -1.0, 1.2, 0.5, 1.5708, 0.9])
    ds = units.to_dataset(rad)
    assert ds[:5] == pytest.approx(np.degrees(rad[:5]), abs=1e-4)
    assert units.to_dataset(np.array([0, 0, 0, 0, 0, units.grip_lo]))[-1] == pytest.approx(0)
    assert units.to_dataset(np.array([0, 0, 0, 0, 0, units.grip_hi]))[-1] == pytest.approx(100)
    assert units.to_sim(ds) == pytest.approx(rad, abs=1e-5)


def test_resample_puts_frames_on_the_grid(episodes, model):
    f = episodes[0]["frames"]
    # Jitter the timestamps the way a once-per-render-frame recorder would.
    jittered = dict(f, time=[t + (0.01 if i % 3 == 1 else 0) for i, t in enumerate(f["time"])])
    out = resample(jittered, model)
    assert np.allclose(np.diff(out["time"]), 1 / FPS)
    quats = out["qpos"][:, 9:13]  # cup freejoint quaternion
    assert np.allclose(np.linalg.norm(quats, axis=1), 1)
    same = resample(f, model)  # already on the grid: unchanged
    assert np.array_equal(same["qpos"], np.asarray(f["qpos"]))
