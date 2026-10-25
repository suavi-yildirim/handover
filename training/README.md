# Training pipeline

Turns played Handover episodes into a LeRobot dataset, fine-tunes SmolVLA on it, and lets
the trained policy play the level in the game's own simulation. Everything runs on a
MacBook (Apple Silicon); long training runs can move to a rented GPU with one setting.

```
game (browser)  ──raw episodes──▶  convert.py  ──LeRobot dataset──▶  train_smolvla.sh
   .jsonl.gz                       renders cameras                   SmolVLA checkpoint
                                   from sim state                          │
rollout.mjs (game sim + scoring) ◀──servo targets── policy_server.py ◀─────┘
```

Formats are described in [docs/episode_schema.md](../docs/episode_schema.md).

## Setup (once)

Needs Python 3.12 and Node 18+.

```sh
cd training
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
source .venv/bin/activate
```

The first training run downloads `lerobot/smolvla_base` (about 2 GB) from Hugging Face.

## 1. Collect episodes

Play in the browser (see the main README) and click **Download episodes**; move the
`.jsonl.gz` files into `training/data/raw/`. To get started without playing, generate
scripted demos with the game's own control, scoring and recording code:

```sh
node scripted_demos.mjs --out data/raw --episodes 50
```

The SmolVLA authors found that about 50 episodes per task is the minimum for good results,
and that 25 was not enough. Vary how you do the task (start positions, approach, speed).

## 2. Check and convert

```sh
python validate.py data/raw                                  # sizes, timing, joint limits
python convert.py data/raw --out data/lerobot/handover_kitchen
python validate.py --dataset data/lerobot/handover_kitchen   # loads it back through LeRobot
```

`convert.py` keeps successful, CC BY 4.0 licensed episodes only (`--include-failed` to keep
all, `--min-score 80` to raise the bar, `--game-version 0.4.1` to use one scene/physics
version; mixing versions mixes object layouts and arm strength) and renders 480×640 views from the `front` and
`wrist_cam` cameras. Add `--push --repo-id <you>/handover_kitchen` to publish the dataset
on the Hugging Face Hub (log in with `hf auth login` first). The dataset card it writes
carries the CC BY 4.0 license and attribution.

To watch episodes, `python preview.py data/raw --out preview.mp4` renders the front and
wrist views side by side.

## 3. Fine-tune SmolVLA

```sh
./train_smolvla.sh                       # MPS, batch 8, 20k steps, checkpoint every 2k
STEPS=2000 BATCH=4 ./train_smolvla.sh    # quick first run
```

Checkpoints land in `outputs/train/smolvla_handover/checkpoints/<step>/pretrained_model`
(`last` points at the newest). Only the action expert is trained; the vision-language
backbone stays frozen, which keeps memory within a MacBook's.

**No GPU?** [colab_train.ipynb](colab_train.ipynb) does the whole loop on a free Google
Colab GPU: 50 scripted demos, conversion, a 5,000-step SmolVLA run, 10 scored rollouts and a
video of the model playing. [Open it in Colab](https://colab.research.google.com/github/syldrm3141/handover/blob/claude/project-thread-5ruxby/training/colab_train.ipynb),
pick a GPU runtime, and press Run all.

**Time.** The SmolVLA docs quote about 4 hours for 20k steps at batch 64 on an A100. An M2
is far slower, so try a short run first and judge from its steps per second. If it's too
slow, run the same script on a rented GPU with `DEVICE=cuda BATCH=64`. The converted
dataset folder is all it needs.

## 4. Watch the policy play

```sh
python policy_server.py --policy outputs/train/smolvla_handover/checkpoints/last/pretrained_model
# in a second terminal:
node rollout.mjs --task cup_on_tray --episodes 20 --out runs/smolvla.jsonl.gz
```

`rollout.mjs` runs the game's own simulation, success checks and scoring headlessly, asks
the server for a chunk of actions (50 steps at 30 fps) whenever the last one runs out,
and prints the success rate. Its attempts are saved in the raw format, so
`convert.py runs/smolvla.jsonl.gz --include-failed …` renders them as videos you can watch,
and they can later feed coach-mode corrections.

The server renders the policy's camera views from the sim state it receives, the same way
the converter did, so the policy always sees the pixels it was trained on. The browser game
can use the same server for coach mode: `POST /act` with `{qpos, qvel, task}` returns
servo targets in radians (see the docstring in `policy_server.py`; CORS is enabled).

## Tests

```sh
python -m pytest tests     # raw-episode validation, units, resampling
```

## Layout

```
handover_train/schema.py   raw format, validation, units (radians ↔ degrees / 0–100), resampling
handover_train/scene.py    loads web/models/*.xml in native MuJoCo, renders cameras
convert.py                 raw episodes → LeRobot dataset
validate.py                checks raw episodes and converted datasets
preview.py                 renders raw episodes to an MP4 to watch
scripted_demos.mjs         scripted cup-on-tray demos using the game's code
train_smolvla.sh           lerobot-train for SmolVLA, MPS defaults
policy_server.py           HTTP server: sim state in, servo targets out
rollout.mjs                policy plays a task in the game's sim and is scored
colab_train.ipynb          the whole loop on a free Colab GPU
```
