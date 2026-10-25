"""Convert raw Handover episodes (exported by the game) into a LeRobot dataset.

Each frame's sim state is replayed in native MuJoCo to render the cameras, so the game
only has to log states and actions. Episodes that fail validation are skipped.

    python convert.py data/raw --out data/lerobot/handover_kitchen
    python convert.py data/raw --out data/lerobot/handover_kitchen --push --repo-id you/handover_kitchen
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import numpy as np
from tqdm import tqdm

from handover_train.scene import Scene
from handover_train.schema import (
    ATTRIBUTION,
    DATA_LICENSE,
    FPS,
    HOMEPAGE,
    HUB_LICENSE,
    IMAGE_SHAPE,
    MOTOR_NAMES,
    ROBOT_TYPE,
    Units,
    find_raw,
    load_episodes,
    resample,
    validate_raw,
)


def features(scene: Scene, image_shape) -> dict:
    vec = lambda names: {"dtype": "float32", "shape": (len(names),), "names": names}  # noqa: E731
    out = {
        "observation.state": vec(MOTOR_NAMES),
        "action": vec(MOTOR_NAMES),
        "observation.ee_pose": vec(["x", "y", "z", "qw", "qx", "qy", "qz"]),
        "observation.environment_state": vec(scene.object_names()),
    }
    for key in scene.cameras:
        out[f"observation.images.{key}"] = {
            "dtype": "video",
            "shape": tuple(image_shape),
            "names": ["height", "width", "channels"],
        }
    return out


def write_card(dataset, out: Path, repo_id: str, game_versions: set[str], tasks: set[str]):
    """Dataset card (README.md) with the license and attribution, saved next to the data
    and pushed with it."""
    from lerobot.datasets.utils import create_lerobot_dataset_card

    description = (
        "Demonstrations recorded in [Handover]({home}), an open-source browser game where players "
        "teach a simulated SO-101 robot arm everyday care tasks. Camera views are rendered from the "
        "recorded simulator state.\n\n"
        "**License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). "
        "Attribution: {attribution}.\n\n"
        "Tasks: {tasks}. Game versions: {versions}."
    ).format(
        home=HOMEPAGE,
        attribution=ATTRIBUTION,
        tasks="; ".join(sorted(tasks)),
        versions=", ".join(sorted(game_versions)) or "unknown",
    )
    card = create_lerobot_dataset_card(
        tags=CARD_TAGS,
        dataset_info=dataset.meta.info,
        license=HUB_LICENSE,
        repo_id=repo_id,
        dataset_description=description,
        url=HOMEPAGE,
    )
    card.save(out / "README.md")
    return description


CARD_TAGS = ["so101", "simulation", "mujoco", "care", "handover"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="raw episode files or folders (.json, .jsonl, optionally .gz)")
    ap.add_argument("--out", required=True, help="dataset folder to create")
    ap.add_argument("--repo-id", default="local/handover_kitchen", help="dataset name (Hub id when pushing)")
    ap.add_argument("--include-failed", action="store_true", help="keep episodes that did not succeed")
    ap.add_argument("--min-score", type=float, default=None, help="drop episodes scoring below this")
    ap.add_argument("--max-episodes", type=int, default=None)
    ap.add_argument(
        "--game-version",
        action="append",
        help="only keep episodes from this game version (repeatable). Scene layout and arm "
        "physics change between versions, so don't mix them in one training set unless you mean to",
    )
    ap.add_argument(
        "--allow-unlicensed",
        action="store_true",
        help=f"also keep episodes without \"license\": \"{DATA_LICENSE}\" (only for your own test data)",
    )
    ap.add_argument("--height", type=int, default=IMAGE_SHAPE[0])
    ap.add_argument("--width", type=int, default=IMAGE_SHAPE[1])
    ap.add_argument("--overwrite", action="store_true", help="delete --out first if it exists")
    ap.add_argument("--push", action="store_true", help="push to the Hugging Face Hub when done")
    args = ap.parse_args(argv)

    from lerobot.datasets import LeRobotDataset

    files = find_raw(args.inputs)
    if not files:
        sys.exit("no raw episodes found")
    out = Path(args.out)
    if out.exists():
        if not args.overwrite:
            sys.exit(f"{out} exists; pass --overwrite to replace it")
        shutil.rmtree(out)

    image_shape = (args.height, args.width, 3)
    scenes: dict[str, Scene] = {}
    dataset = None
    kept, skipped = 0, []
    game_versions: set[str] = set()
    tasks: set[str] = set()
    episodes = []
    for path in files:
        try:
            episodes += [(f"{path.name}#{i + 1}", ep) for i, ep in enumerate(load_episodes(path))]
        except (OSError, ValueError) as e:
            skipped.append((path.name, f"unreadable: {e}"))

    for name, ep in episodes:
        if args.max_episodes is not None and kept >= args.max_episodes:
            break
        model_file = ep.get("model", "")
        if model_file not in scenes:
            try:
                scenes[model_file] = Scene(model_file, image_shape)
            except Exception as e:  # noqa: BLE001 - bad model path in one file shouldn't stop the run
                skipped.append((name, f"cannot load model {model_file!r}: {e}"))
                continue
        scene = scenes[model_file]
        errors = validate_raw(ep, scene.model)
        if errors:
            skipped.append((name, "; ".join(errors)))
            continue
        if ep.get("license") != DATA_LICENSE and not args.allow_unlicensed:
            skipped.append((name, f"license is {ep.get('license')!r}, not {DATA_LICENSE!r}"))
            continue
        if args.game_version and ep.get("game_version") not in args.game_version:
            skipped.append((name, f"game_version {ep.get('game_version')!r} not selected"))
            continue
        if not args.include_failed and not ep.get("success", False):
            skipped.append((name, "not successful"))
            continue
        if args.min_score is not None and ep.get("score", 0) < args.min_score:
            skipped.append((name, f"score {ep.get('score')} < {args.min_score}"))
            continue

        if dataset is None:
            feats = features(scene, image_shape)
            dataset = LeRobotDataset.create(
                repo_id=args.repo_id, fps=FPS, features=feats, root=out, robot_type=ROBOT_TYPE, use_videos=True
            )
            first_model = model_file
            env_names = feats["observation.environment_state"]["names"]
        elif model_file != first_model and scene.object_names() != env_names:
            skipped.append((name, f"level {model_file} has different objects than {first_model}"))
            continue

        units = Units(scene.model)
        frames = resample(ep["frames"], scene.model)
        qpos, qvel = frames["qpos"], frames["qvel"]
        state = units.state(qpos)
        action = units.action(frames["ctrl"])
        for i in tqdm(range(len(qpos)), desc=name, leave=False):
            scene.set_state(qpos[i], qvel[i])
            frame = {
                "observation.state": state[i],
                "action": action[i],
                "observation.ee_pose": scene.ee_pose(),
                "observation.environment_state": scene.environment_state(),
                "task": ep["task"],
            }
            for key, img in scene.render().items():
                frame[f"observation.images.{key}"] = img
            dataset.add_frame(frame)
        dataset.save_episode()
        kept += 1
        game_versions.add(str(ep.get("game_version", "unknown")))
        tasks.add(ep["task"])
        print(f"[{kept}] {name}: {len(qpos)} frames, task {ep['task']!r}")

    for s in scenes.values():
        s.close()
    for name, why in skipped:
        print(f"skipped {name}: {why}")
    if dataset is None:
        sys.exit("no episodes passed validation; nothing written")
    dataset.finalize()
    description = write_card(dataset, out, args.repo_id, game_versions, tasks)
    print(f"wrote {kept} episodes ({dataset.meta.total_frames} frames) to {out}; skipped {len(skipped)}")
    if len(game_versions) > 1:
        print(f"note: mixes game versions {sorted(game_versions)}; use --game-version to pick one")
    if args.push:
        # LeRobot's default card license is apache-2.0; play data is CC BY 4.0.
        dataset.push_to_hub(
            license=HUB_LICENSE,
            tags=CARD_TAGS,
            dataset_description=description,
            url=HOMEPAGE,
        )
        print(f"pushed to https://huggingface.co/datasets/{args.repo_id}")


if __name__ == "__main__":
    main()
