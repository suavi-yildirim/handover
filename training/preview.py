"""Render raw Handover episodes to an MP4 you can watch: front and wrist cameras side by
side, one episode after another, rendered from the logged sim state.

    python preview.py data/raw --out preview.mp4 --max-episodes 3
"""

from __future__ import annotations

import argparse
import sys

import av
import numpy as np
from PIL import Image, ImageDraw

from handover_train.scene import Scene
from handover_train.schema import FPS, find_raw, load_episodes, resample


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="raw episode files or folders")
    ap.add_argument("--out", default="preview.mp4")
    ap.add_argument("--max-episodes", type=int, default=3)
    ap.add_argument("--height", type=int, default=360)
    ap.add_argument("--width", type=int, default=480)
    args = ap.parse_args(argv)

    episodes = [ep for f in find_raw(args.inputs) for ep in load_episodes(f)][: args.max_episodes]
    if not episodes:
        sys.exit("no raw episodes found")
    scenes: dict[str, Scene] = {}
    with av.open(args.out, "w") as container:
        stream = container.add_stream("libx264", rate=FPS)
        stream.width, stream.height, stream.pix_fmt = 2 * args.width, args.height, "yuv420p"
        for n, ep in enumerate(episodes, 1):
            model_file = ep["model"]
            scene = scenes.setdefault(model_file, Scene(model_file, (args.height, args.width, 3)))
            frames = resample(ep["frames"], scene.model)
            result = f"success, score {ep.get('score')}" if ep.get("success") else "failed"
            label = f"{n}/{len(episodes)}  {ep['task']}  ({result})"
            for i, qpos in enumerate(frames["qpos"]):
                scene.set_state(qpos)
                views = scene.render()
                img = Image.fromarray(np.concatenate([views["front"], views["wrist"]], axis=1))
                draw = ImageDraw.Draw(img)
                draw.rectangle([0, 0, img.width, 22], fill=(0, 0, 0))
                draw.text((8, 5), f"{label}   t={i / FPS:4.1f}s", fill=(255, 255, 255))
                for packet in stream.encode(av.VideoFrame.from_image(img)):
                    container.mux(packet)
            print(f"rendered episode {n}: {len(frames['qpos'])} frames")
        for packet in stream.encode():
            container.mux(packet)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
