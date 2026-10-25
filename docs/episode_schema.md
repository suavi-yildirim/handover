# Episode schema

How a played episode travels from the game to a trained policy:

1. The browser game records **raw episodes** (`web/src/recorder.js`): full simulator state
   per frame, in sim-native units, no images.
2. `training/convert.py` replays each frame's state in native MuJoCo, renders the camera
   views, and writes a **LeRobot dataset** (v3.0).
3. SmolVLA is fine-tuned on that dataset; `training/policy_server.py` serves it back to the
   sim, rendering the same cameras from the sim state.

Because images are rendered from state, cameras, resolution, lighting and textures can
change later without re-collecting data.

## Raw episode (written by the game)

The browser saves one gzipped JSON Lines file per session (`.jsonl.gz`, one episode per
line). The converter also accepts `.json` (one episode), `.jsonl` and `.json.gz`.

```json
{
  "format": "handover-episode",
  "version": 1,
  "robot": "so101",
  "level": "kitchen",
  "model": "models/kitchen.xml",
  "fps": 30,
  "task_id": "cup_on_tray",
  "task": "Put the cup on the tray.",
  "episode_id": "uuid",
  "started_at": "2026-10-25T19:00:00Z",
  "inputs": ["keyboard"],
  "contributor_id": "anonymous id",
  "game_version": "0.3.0",
  "mujoco_version": "3.16.0",
  "scene_seed": null,
  "license": "CC-BY-4.0",
  "success": true,
  "score": 95,
  "metrics": {"time": 1, "smoothness": 0.76, "raw": {}, "reason": null},
  "events": [{"t": 3.2, "type": "grasp"}],
  "joint_names": ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"],
  "frames": {"time": [], "qpos": [[]], "qvel": [[]], "ctrl": [[]]},
  "intent": {"target": [], "pitch": [], "roll": [], "grip_closed": []}
}
```

| field | meaning |
|---|---|
| `model` | level MJCF, relative to `web/`. The converter loads the same file. |
| `joint_names` | the 6 SO-101 joints, in actuator order (= state/action order) |
| `frames` | columnar arrays of equal length T, in radians and meters |
| `frames.time` | sim time; one frame per 1/30 s (within one 2 ms physics step) |
| `frames.qpos`, `frames.qvel` | full MuJoCo state at that instant (arm, then each free object) |
| `frames.ctrl` | servo targets being applied at that instant |
| `success`, `score`, `metrics` | from the task's success check and scoring (`docs/tasks.md`) |
| `license` | `CC-BY-4.0` for all play data; the converter skips episodes without it |
| `game_version` | scene layout and arm physics change between versions; pick one with `convert.py --game-version` |
| `intent`, `events`, `inputs`, ids | extra; the converter ignores them |

Task strings: one fixed imperative sentence per `task_id`. The trained policy is prompted
with exactly this string, so changing it means re-converting.

| task_id | task |
|---|---|
| `cup_on_tray` | Put the cup on the tray. |
| `bring_medication` | Hand the medicine bottle to the person. |
| `tidy_fall_hazard` | Move the glasses case away from the table edge to the safe spot. |

Episodes are only comparable with the scene version they were recorded in: a change that
adds or removes a free body changes `nq`, and the converter rejects episodes whose state
size doesn't match the current model.

## License

Recorded play data is released under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
attribution "Suavi Yildirim and the Handover contributors" (the code is Apache-2.0).
The converter writes this into the dataset card (`README.md` in the dataset folder, Hub
license `cc-by-4.0`) and uses it when pushing to the Hugging Face Hub.

## LeRobot dataset (written by the converter)

LeRobot 0.6.1, codebase v3.0, 30 fps, `robot_type` `so101_follower`.

| key | dtype | shape | notes |
|---|---|---|---|
| `observation.state` | float32 | [6] | `shoulder_pan.pos` … `gripper.pos`: joints in degrees, gripper 0–100 (0 = closed, over the joint range −0.1745…1.7453 rad), like `so101_follower` with `use_degrees` |
| `action` | float32 | [6] | same names and units: the commanded servo targets |
| `observation.images.front` | video | 480×640×3 | MJCF camera `front` |
| `observation.images.wrist` | video | 480×640×3 | MJCF camera `wrist_cam` (on the SO-101 camera mount) |
| `observation.ee_pose` | float32 | [7] | `gripperframe` site: x, y, z (m), qw, qx, qy, qz |
| `observation.environment_state` | float32 | [7·k] | every free object's pose (x, y, z, qw, qx, qy, qz), named `cup.x` … |
| `task` | string | | the episode's `task` sentence |

Conversion details:

- If frame times drift from the exact 1/30 s grid (older recordings), frames are
  resampled: `qpos`/`qvel` linearly (quaternions renormalized), `ctrl` held from the
  previous frame. Gaps over 0.2 s reject the episode.
- Episodes that failed validation, didn't succeed, or score below `--min-score` are skipped.
- Validation also rejects arm joints outside their limits (+2°), as a first check that a
  real robot could execute the motion.

The pretrained `smolvla_base` expects cameras named `camera1`…`camera3`; training maps
`front → camera1` and `wrist → camera2` with `--rename_map`, and the saved checkpoint
applies the same mapping at inference.
