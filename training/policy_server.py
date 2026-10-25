"""Serve a trained LeRobot policy (SmolVLA or any other) to the Handover sim.

The client (rollout.mjs, or the browser game in coach mode) sends the current sim state;
the server renders the dataset cameras from that state in native MuJoCo, exactly as the
converter did for training, runs the policy, and returns a chunk of servo targets in sim
radians, one per 1/30 s.

    python policy_server.py --policy outputs/train/smolvla_handover/checkpoints/last/pretrained_model

Endpoints (JSON, CORS enabled so the game page can call it):
    GET  /info   -> {policy, device, fps, joints, cameras}
    POST /reset  -> clears the policy's internal state; call at the start of each episode
    POST /act    {"qpos": [nq], "qvel": [nv] (optional), "task": "Put the cup on the tray.",
                  "model": "models/kitchen.xml" (optional)}
              -> {"actions": [[6 ctrl values, radians], ...], "fps": 30, "latency_ms": ...}
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import torch

from handover_train.scene import Scene
from handover_train.schema import CAMERAS, FPS, JOINTS, ROBOT_TYPE, Units


class PolicyRunner:
    def __init__(self, policy_path: str, device: str | None, image_shape, n_action_steps: int | None):
        from lerobot.configs import PreTrainedConfig
        from lerobot.policies.factory import get_policy_class, make_pre_post_processors
        from lerobot.utils.device_utils import get_safe_torch_device

        cfg = PreTrainedConfig.from_pretrained(policy_path)
        cfg.device = device or ("mps" if torch.backends.mps.is_available() else cfg.device or "cpu")
        if n_action_steps is not None:
            cfg.n_action_steps = n_action_steps
        self.device = get_safe_torch_device(cfg.device)
        self.policy = get_policy_class(cfg.type).from_pretrained(policy_path, config=cfg)
        self.policy.to(self.device).eval()
        # The checkpoint's processors carry the dataset normalization stats and the
        # camera rename map used in training.
        self.pre, self.post = make_pre_post_processors(
            cfg, pretrained_path=policy_path, preprocessor_overrides={"device_processor": {"device": cfg.device}}
        )
        self.cfg = cfg
        self.image_shape = image_shape
        self.scenes: dict[str, Scene] = {}

    def scene(self, model_file: str) -> Scene:
        if model_file not in self.scenes:
            self.scenes[model_file] = Scene(model_file, self.image_shape)
        return self.scenes[model_file]

    def reset(self):
        self.policy.reset()
        self.pre.reset()
        self.post.reset()

    def observation(self, scene: Scene, qpos, qvel) -> dict[str, np.ndarray]:
        scene.set_state(np.asarray(qpos, dtype=np.float64), None if qvel is None else np.asarray(qvel))
        units = Units(scene.model)
        obs = {
            "observation.state": units.state(scene.data.qpos),
            "observation.ee_pose": scene.ee_pose(),
            "observation.environment_state": scene.environment_state(),
        }
        for key, img in scene.render().items():
            obs[f"observation.images.{key}"] = img
        return obs

    @torch.inference_mode()
    def act(self, qpos, qvel=None, task: str = "", model_file: str = "models/kitchen.xml") -> np.ndarray:
        from lerobot.policies.utils import prepare_observation_for_inference

        scene = self.scene(model_file)
        if len(qpos) != scene.model.nq:
            raise ValueError(f"qpos has {len(qpos)} values, {model_file} has nq={scene.model.nq}")
        obs = self.observation(scene, qpos, qvel)
        batch = prepare_observation_for_inference(obs, self.device, task, ROBOT_TYPE)
        batch = self.pre(batch)
        chunk = self.policy.predict_action_chunk(batch)[:, : self.cfg.n_action_steps]
        chunk = self.post(chunk).squeeze(0).float().cpu().numpy()  # [T, 6] dataset units
        return Units(scene.model).to_sim(chunk)


def make_handler(runner: PolicyRunner):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):  # noqa: N802 - CORS preflight from the game page
            self._send(204, {})

        def do_GET(self):  # noqa: N802
            if self.path != "/info":
                return self._send(404, {"error": "unknown path"})
            self._send(200, {
                "policy": runner.cfg.type,
                "device": str(runner.device),
                "fps": FPS,
                "chunk": runner.cfg.n_action_steps,
                "joints": JOINTS,
                "cameras": list(CAMERAS),
            })

        def do_POST(self):  # noqa: N802
            try:
                length = int(self.headers.get("Content-Length", 0))
                req = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/reset":
                    runner.reset()
                    return self._send(200, {"ok": True})
                if self.path != "/act":
                    return self._send(404, {"error": "unknown path"})
                t0 = time.perf_counter()
                actions = runner.act(
                    req["qpos"], req.get("qvel"), req.get("task", ""), req.get("model", "models/kitchen.xml")
                )
                self._send(200, {
                    "actions": np.round(actions, 6).tolist(),
                    "fps": FPS,
                    "latency_ms": round(1000 * (time.perf_counter() - t0), 1),
                })
            except (KeyError, ValueError) as e:
                self._send(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001 - report to the client instead of dropping the connection
                logging.exception("act failed")
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

        def log_message(self, fmt, *args):
            logging.debug(fmt, *args)

    return Handler


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--policy", required=True, help="checkpoint folder (…/pretrained_model) or Hub id")
    ap.add_argument("--device", default=None, help="mps, cuda or cpu (default: mps when available)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--height", type=int, default=480, help="must match the training images")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--n-action-steps", type=int, default=None, help="actions per chunk to execute (default: policy's)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    runner = PolicyRunner(args.policy, args.device, (args.height, args.width, 3), args.n_action_steps)
    # One thread on purpose: the MuJoCo renderer's GL context belongs to the thread that made it.
    server = HTTPServer(("127.0.0.1", args.port), make_handler(runner))
    logging.info("serving %s on %s at http://127.0.0.1:%d", runner.cfg.type, runner.device, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
