"""Check raw Handover episodes, a converted LeRobot dataset, or both.

    python validate.py data/raw                         # raw episodes from the game
    python validate.py --dataset data/lerobot/handover_kitchen

Exits non-zero if anything is invalid.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter

import numpy as np

from handover_train.schema import (
    CAMERAS,
    DATA_LICENSE,
    FPS,
    MOTOR_NAMES,
    find_raw,
    load_episodes,
    validate_raw,
)


def check_raw(paths) -> int:
    from handover_train.scene import Scene

    files = find_raw(paths)
    if not files:
        print("no raw episode files found")
        return 1
    scenes, bad, stats = {}, 0, Counter()
    lengths, scores = [], []
    versions, licenses = Counter(), Counter()
    for path in files:
        try:
            episodes = load_episodes(path)
        except (OSError, ValueError) as e:
            print(f"FAIL {path}: unreadable ({e})")
            bad += 1
            continue
        for i, ep in enumerate(episodes):
            name = f"{path.name}#{i + 1}"
            model_file = ep.get("model", "")
            try:
                scene = scenes.setdefault(model_file, Scene(model_file))
                errors = validate_raw(ep, scene.model)
            except Exception as e:  # noqa: BLE001
                errors = [f"cannot load model {model_file!r}: {e}"]
            if errors:
                bad += 1
                print(f"FAIL {name}: " + "; ".join(errors))
                continue
            stats[(ep["task_id"], bool(ep.get("success")))] += 1
            versions[str(ep.get("game_version", "unknown"))] += 1
            licenses[str(ep.get("license"))] += 1
            lengths.append(len(ep["frames"]["time"]))
            if ep.get("success"):
                scores.append(ep.get("score", 0))
    for (task, ok), n in sorted(stats.items()):
        print(f"{task}: {n} {'successful' if ok else 'failed'}")
    if lengths:
        print(f"episode length: {min(lengths)}-{max(lengths)} frames, mean {np.mean(lengths) / FPS:.1f} s")
    if scores:
        print(f"score of successful episodes: min {min(scores)}, mean {np.mean(scores):.0f}, max {max(scores)}")
    print(f"game versions: {dict(versions)}; licenses: {dict(licenses)}")
    if licenses.keys() - {DATA_LICENSE}:
        print(f"note: convert.py skips episodes whose license isn't {DATA_LICENSE}")
    print(f"{sum(stats.values())} valid, {bad} invalid")
    return 1 if bad else 0


def check_dataset(root) -> int:
    from lerobot.datasets import LeRobotDataset

    ds = LeRobotDataset(repo_id="local/handover", root=root)
    problems = []
    for key in ["observation.state", "action"]:
        names = ds.meta.features.get(key, {}).get("names")
        if names != MOTOR_NAMES:
            problems.append(f"{key} names {names} != {MOTOR_NAMES}")
    for cam in CAMERAS:
        if f"observation.images.{cam}" not in ds.meta.features:
            problems.append(f"missing observation.images.{cam}")
    if ds.meta.fps != FPS:
        problems.append(f"fps {ds.meta.fps} != {FPS}")
    for idx in {0, len(ds) // 2, len(ds) - 1}:
        item = ds[idx]
        for key in ["observation.state", "action"]:
            if not np.isfinite(item[key].numpy()).all():
                problems.append(f"frame {idx}: {key} not finite")
        for cam in CAMERAS:
            img = item[f"observation.images.{cam}"]
            if img.ndim != 3 or img.shape[0] != 3:
                problems.append(f"frame {idx}: {cam} image has shape {tuple(img.shape)}")
            elif float(img.float().std()) < 1e-3:
                problems.append(f"frame {idx}: {cam} image is blank")
    print(f"{ds.meta.total_episodes} episodes, {ds.meta.total_frames} frames, tasks {list(ds.meta.tasks.index)}")
    stats = ds.meta.stats
    for key in ["observation.state", "action"]:
        print(f"{key} min {np.round(stats[key]['min'], 1)} max {np.round(stats[key]['max'], 1)}")
    for p in problems:
        print(f"FAIL {p}")
    print("dataset OK" if not problems else f"{len(problems)} problems")
    return 1 if problems else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("raw", nargs="*", help="raw episode files or folders")
    ap.add_argument("--dataset", help="converted LeRobot dataset folder")
    args = ap.parse_args(argv)
    if not args.raw and not args.dataset:
        ap.error("give raw episodes and/or --dataset")
    code = 0
    if args.raw:
        code |= check_raw(args.raw)
    if args.dataset:
        code |= check_dataset(args.dataset)
    sys.exit(code)


if __name__ == "__main__":
    main()
