"""Native MuJoCo copy of a Handover level, used to render cameras and run policies.

Loads the same MJCF the browser game uses (from web/), so physics and kinematics match.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

if sys.platform == "linux":
    # Headless Linux (CI, cloud GPUs) has no display; macOS renders offscreen natively.
    os.environ.setdefault("MUJOCO_GL", "egl")

import mujoco
import numpy as np

from .schema import CAMERAS, IMAGE_SHAPE

WEB = Path(__file__).resolve().parents[2] / "web"
EE_SITE = "gripperframe"

# Stand-in cameras added when the MJCF has none of the names in schema.CAMERAS.
# "front" looks down at the table from the robot's right, clear of the kitchen counter;
# "wrist" rides on the gripper body looking along the jaws.
DEFAULT_CAMERAS = {
    "front": dict(body="world", pos=(0.12, -0.55, 0.5), lookat=(0.17, 0.05, 0.0), fovy=60),
    "wrist": dict(body="gripper", pos=(0.0, 0.055, -0.05), lookat=(0.012, 0.0, -0.11), fovy=70),
}


def _lookat_quat(pos, target, up=(0.0, 0.0, 1.0)):
    """Quaternion (wxyz) for a MuJoCo camera at pos looking at target (camera looks along -z)."""
    pos, target, up = (np.asarray(v, dtype=np.float64) for v in (pos, target, up))
    back = pos - target
    back /= np.linalg.norm(back)
    if abs(back @ up) > 0.99:
        up = np.array([1.0, 0.0, 0.0])
    right = np.cross(up, back)
    right /= np.linalg.norm(right)
    cam_up = np.cross(back, right)
    quat = np.zeros(4)
    mujoco.mju_mat2Quat(quat, np.stack([right, cam_up, back], axis=1).flatten())
    return quat


def model_path(raw_model: str) -> Path:
    """Resolve the raw episode's `model` field (relative to web/)."""
    p = Path(raw_model)
    return p if p.is_absolute() else WEB / p


class Scene:
    def __init__(self, model_file: str | Path = "models/kitchen.xml", image_shape=IMAGE_SHAPE):
        spec = mujoco.MjSpec.from_file(str(model_path(str(model_file))))
        existing = {c.name for c in spec.cameras}
        self.cameras = {}
        for key, names in CAMERAS.items():
            name = next((n for n in names if n in existing), None)
            if name is None:
                d = DEFAULT_CAMERAS[key]
                body = spec.worldbody if d["body"] == "world" else spec.body(d["body"])
                name = f"handover_{key}"
                body.add_camera(name=name, pos=d["pos"], quat=_lookat_quat(d["pos"], d["lookat"]), fovy=d["fovy"])
            self.cameras[key] = name
        h, w, _ = image_shape
        spec.visual.global_.offwidth = max(spec.visual.global_.offwidth, w)
        spec.visual.global_.offheight = max(spec.visual.global_.offheight, h)
        self.model = spec.compile()
        self.data = mujoco.MjData(self.model)
        self.image_shape = image_shape
        self._renderer = None
        self.ee_site = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SITE, EE_SITE)
        # Free-floating objects (cup, bottle, ...) make up the environment state.
        self.objects = [
            j for j in range(self.model.njnt) if self.model.jnt_type[j] == mujoco.mjtJoint.mjJNT_FREE
        ]
        self.reset()

    # -- state ---------------------------------------------------------------------
    def reset(self, keyframe: int = 0):
        if self.model.nkey > keyframe:
            mujoco.mj_resetDataKeyframe(self.model, self.data, keyframe)
        else:
            mujoco.mj_resetData(self.model, self.data)
        mujoco.mj_forward(self.model, self.data)

    def set_state(self, qpos, qvel=None):
        self.data.qpos[:] = qpos
        if qvel is not None:
            self.data.qvel[:] = qvel
        mujoco.mj_forward(self.model, self.data)

    def body_pos(self, name: str) -> np.ndarray:
        return self.data.body(name).xpos.copy()

    def ee_pose(self) -> np.ndarray:
        """Gripper frame position (m) and orientation quaternion (wxyz), float32 [7]."""
        quat = np.zeros(4)
        mujoco.mju_mat2Quat(quat, self.data.site_xmat[self.ee_site])
        return np.concatenate([self.data.site_xpos[self.ee_site], quat]).astype(np.float32)

    def object_names(self) -> list[str]:
        names = []
        for j in self.objects:
            body = mujoco.mj_id2name(self.model, mujoco.mjtObj.mjOBJ_BODY, self.model.jnt_bodyid[j])
            names += [f"{body}.{c}" for c in ("x", "y", "z", "qw", "qx", "qy", "qz")]
        return names

    def environment_state(self) -> np.ndarray:
        """Poses of all free objects, xyz + quat wxyz each, float32 [7 * n]."""
        adr = [self.model.jnt_qposadr[j] for j in self.objects]
        return np.concatenate([self.data.qpos[a : a + 7] for a in adr]).astype(np.float32)

    # -- rendering -----------------------------------------------------------------
    def render(self) -> dict[str, np.ndarray]:
        """Render every dataset camera at the current state, HWC uint8 per key."""
        if self._renderer is None:
            h, w, _ = self.image_shape
            self._renderer = mujoco.Renderer(self.model, height=h, width=w)
        out = {}
        for key, cam in self.cameras.items():
            self._renderer.update_scene(self.data, camera=cam)
            out[key] = self._renderer.render().copy()
        return out

    def close(self):
        if self._renderer is not None:
            self._renderer.close()
            self._renderer = None
