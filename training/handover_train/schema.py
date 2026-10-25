"""The raw episode format the game exports and the LeRobot features the converter writes.

See docs/episode_schema.md. Raw episodes are in sim-native units (radians); everything
here converts them to the dataset units used by LeRobot's so101_follower with
use_degrees=True: joints in degrees, gripper 0-100 (0 = closed).
"""

from __future__ import annotations

import gzip
import json
import math
from pathlib import Path

import numpy as np

FORMAT = "handover-episode"
VERSION = 1
FPS = 30
ROBOT_TYPE = "so101_follower"

# Actuator order of the SO-101 model, which is also the order of state and action.
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
GRIPPER = "gripper"
MOTOR_NAMES = [f"{j}.pos" for j in JOINTS]

# Dataset camera key -> MJCF camera names to try, in order. The converter adds a
# stand-in camera through MjSpec when none of them exist (see scene.py).
CAMERAS = {"front": ["front"], "wrist": ["wrist", "wrist_cam"]}
IMAGE_SHAPE = (480, 640, 3)  # height, width, channels

# How the pretrained smolvla_base names its cameras. Passed as --rename_map when training
# and applied the same way when running the policy.
SMOLVLA_RENAME = {
    "observation.images.front": "observation.images.camera1",
    "observation.images.wrist": "observation.images.camera2",
}

# Frames are resampled onto an exact 1/FPS grid (see resample); longer gaps mean the
# recording stalled and the episode is rejected.
MAX_GAP_S = 0.2

RAW_REQUIRED = ["format", "version", "robot", "level", "model", "fps", "task_id", "task", "joint_names", "frames"]


RAW_SUFFIXES = (".json", ".json.gz", ".jsonl", ".jsonl.gz")


def load_episodes(path: str | Path) -> list[dict]:
    """Read one raw file: .json holds one episode, .jsonl one episode per line (the
    browser saves a session as one .jsonl.gz). Both may be gzipped."""
    path = Path(path)
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as f:
        if path.name.endswith((".jsonl", ".jsonl.gz")):
            return [json.loads(line) for line in f if line.strip()]
        return [json.load(f)]


def find_raw(paths: list[str | Path]) -> list[Path]:
    """Expand files and folders into raw episode files, sorted by name."""
    out = []
    for p in map(Path, paths):
        if p.is_dir():
            out += [f for f in p.rglob("*") if f.name.endswith(RAW_SUFFIXES)]
        else:
            out.append(p)
    return sorted(out)


def validate_raw(ep: dict, model=None) -> list[str]:
    """Return a list of problems with a raw episode (empty means valid).

    With a MuJoCo model, also checks sizes against it and that the arm stays within its
    joint limits (layer 3 of CLAUDE.md: could a real robot execute this?).
    """
    errors = [f"missing field '{k}'" for k in RAW_REQUIRED if k not in ep]
    if errors:
        return errors
    if ep["format"] != FORMAT:
        errors.append(f"format is {ep['format']!r}, expected {FORMAT!r}")
    if ep["version"] != VERSION:
        errors.append(f"version {ep['version']} not supported (expected {VERSION})")
    if ep["fps"] != FPS:
        errors.append(f"fps is {ep['fps']}, expected {FPS}")
    if list(ep["joint_names"]) != JOINTS:
        errors.append(f"joint_names {ep['joint_names']} != {JOINTS}")
    if not isinstance(ep["task"], str) or not ep["task"].strip():
        errors.append("task must be a non-empty sentence")

    frames = ep["frames"]
    for k in ("time", "qpos", "qvel", "ctrl"):
        if k not in frames:
            errors.append(f"frames.{k} missing")
    if errors:
        return errors
    lengths = {k: len(frames[k]) for k in ("time", "qpos", "qvel", "ctrl")}
    if len(set(lengths.values())) != 1:
        return errors + [f"frames arrays differ in length: {lengths}"]
    if lengths["time"] < 2:
        return errors + ["episode has fewer than 2 frames"]

    try:
        t = np.asarray(frames["time"], dtype=np.float64)
        qpos = np.asarray(frames["qpos"], dtype=np.float64)
        qvel = np.asarray(frames["qvel"], dtype=np.float64)
        ctrl = np.asarray(frames["ctrl"], dtype=np.float64)
    except ValueError:
        return errors + ["frames rows have inconsistent widths"]
    for name, a in (("time", t), ("qpos", qpos), ("qvel", qvel), ("ctrl", ctrl)):
        if not np.isfinite(a).all():
            errors.append(f"frames.{name} has NaN or inf")
    dt = np.diff(t)
    if (dt <= 0).any():
        errors.append("frames.time must increase")
    elif dt.max() > MAX_GAP_S:
        errors.append(f"recording has a {dt.max():.2f} s gap (more than {MAX_GAP_S} s)")

    if model is not None:
        import mujoco

        for name, a, n in (("qpos", qpos, model.nq), ("qvel", qvel, model.nv), ("ctrl", ctrl, model.nu)):
            if a.shape[1] != n:
                errors.append(f"frames.{name} rows have {a.shape[1]} values, model has {n}")
        if errors:
            return errors
        tol = math.radians(2)
        for j in JOINTS:
            jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, j)
            lo, hi = model.jnt_range[jid]
            q = qpos[:, model.jnt_qposadr[jid]]
            if q.min() < lo - tol or q.max() > hi + tol:
                errors.append(f"{j} leaves its joint range [{lo:.2f}, {hi:.2f}] rad")
    return errors


def quaternion_slices(model) -> list[slice]:
    """qpos ranges holding quaternions (free and ball joints)."""
    import mujoco

    out = []
    for j in range(model.njnt):
        adr, kind = model.jnt_qposadr[j], model.jnt_type[j]
        if kind == mujoco.mjtJoint.mjJNT_FREE:
            out.append(slice(adr + 3, adr + 7))
        elif kind == mujoco.mjtJoint.mjJNT_BALL:
            out.append(slice(adr, adr + 4))
    return out


def resample(frames: dict, model, fps: int = FPS) -> dict[str, np.ndarray]:
    """Put frames on an exact 1/fps grid starting at the first frame.

    The browser samples once per rendered frame, so raw spacing jitters around 1/fps.
    qpos and qvel are linearly interpolated (quaternions renormalized); ctrl is the
    target being applied at that instant, i.e. held from the previous raw frame.
    """
    t = np.asarray(frames["time"], dtype=np.float64)
    qpos = np.asarray(frames["qpos"], dtype=np.float64)
    qvel = np.asarray(frames["qvel"], dtype=np.float64)
    ctrl = np.asarray(frames["ctrl"], dtype=np.float64)
    grid = t[0] + np.arange(int(round((t[-1] - t[0]) * fps)) + 1) / fps
    if len(grid) == len(t) and np.abs(grid - t).max() < 0.1 / fps:
        # Already on the grid to within a physics step or so (the game records after
        # every physics step): keep the frames as they are.
        return {"time": grid, "qpos": qpos, "qvel": qvel, "ctrl": ctrl}

    hi = np.clip(np.searchsorted(t, grid, side="right"), 1, len(t) - 1)
    lo = hi - 1
    w = np.clip((grid - t[lo]) / (t[hi] - t[lo]), 0.0, 1.0)[:, None]
    qpos_r = qpos[lo] * (1 - w) + qpos[hi] * w
    for sl in quaternion_slices(model):
        a, b = qpos[lo, sl], qpos[hi, sl]
        b = np.where((a * b).sum(1, keepdims=True) < 0, -b, b)  # take the short way round
        q = a * (1 - w) + b * w
        qpos_r[:, sl] = q / np.linalg.norm(q, axis=1, keepdims=True)
    qvel_r = qvel[lo] * (1 - w) + qvel[hi] * w
    held = np.where(w[:, 0] >= 1.0, hi, lo)
    return {"time": grid, "qpos": qpos_r, "qvel": qvel_r, "ctrl": ctrl[held]}


class Units:
    """Converts between sim radians and dataset units for the 6 SO-101 joints."""

    def __init__(self, model):
        import mujoco

        self.joint_ids = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, j) for j in JOINTS]
        self.actuator_ids = [mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR, j) for j in JOINTS]
        if min(self.joint_ids + self.actuator_ids) < 0:
            raise ValueError(f"model is missing one of the SO-101 joints/actuators {JOINTS}")
        self.qpos_adr = np.array([model.jnt_qposadr[j] for j in self.joint_ids])
        g = model.jnt_range[self.joint_ids[JOINTS.index(GRIPPER)]]
        self.grip_lo, self.grip_hi = float(g[0]), float(g[1])
        self.ctrl_range = model.actuator_ctrlrange[self.actuator_ids].copy()

    def to_dataset(self, rad: np.ndarray) -> np.ndarray:
        """[..., 6] sim radians -> [..., 6] degrees with the gripper as 0-100."""
        out = np.degrees(rad).astype(np.float32)
        g = (rad[..., -1] - self.grip_lo) / (self.grip_hi - self.grip_lo) * 100.0
        out[..., -1] = g
        return out

    def to_sim(self, values: np.ndarray) -> np.ndarray:
        """Inverse of to_dataset, clipped to the actuator ctrl ranges."""
        values = np.asarray(values, dtype=np.float64)
        out = np.radians(values)
        out[..., -1] = self.grip_lo + values[..., -1] / 100.0 * (self.grip_hi - self.grip_lo)
        return np.clip(out, self.ctrl_range[:, 0], self.ctrl_range[:, 1])

    def state(self, qpos: np.ndarray) -> np.ndarray:
        return self.to_dataset(qpos[..., self.qpos_adr])

    def action(self, ctrl: np.ndarray) -> np.ndarray:
        return self.to_dataset(ctrl[..., self.actuator_ids])
