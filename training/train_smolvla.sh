#!/usr/bin/env bash
# Fine-tune SmolVLA on a converted Handover dataset. Defaults suit a MacBook (Apple
# Silicon, MPS); override any setting with an environment variable, e.g.
#
#   STEPS=2000 BATCH=4 ./train_smolvla.sh
#   DEVICE=cuda BATCH=64 STEPS=20000 ./train_smolvla.sh     # rented GPU
#
# Extra lerobot-train flags can be appended: ./train_smolvla.sh --wandb.enable=true
set -euo pipefail
cd "$(dirname "$0")"

DATASET=${DATASET:-data/lerobot/handover_kitchen}
REPO_ID=${REPO_ID:-local/handover_kitchen}
OUTPUT=${OUTPUT:-outputs/train/smolvla_handover}
DEVICE=${DEVICE:-mps}
BATCH=${BATCH:-8}
STEPS=${STEPS:-20000}
SAVE_FREQ=${SAVE_FREQ:-2000}
WORKERS=${WORKERS:-4}

# A few ops have no MPS kernel yet; let PyTorch run those on the CPU instead of failing.
export PYTORCH_ENABLE_MPS_FALLBACK=1

# smolvla_base was pretrained with cameras named camera1..3; map ours onto them.
# Keep in sync with SMOLVLA_RENAME in handover_train/schema.py.
RENAME='{"observation.images.front": "observation.images.camera1", "observation.images.wrist": "observation.images.camera2"}'

exec lerobot-train \
  --policy.path=lerobot/smolvla_base \
  --policy.device="$DEVICE" \
  --policy.push_to_hub=false \
  --dataset.repo_id="$REPO_ID" \
  --dataset.root="$DATASET" \
  --rename_map="$RENAME" \
  --batch_size="$BATCH" \
  --steps="$STEPS" \
  --save_freq="$SAVE_FREQ" \
  --num_workers="$WORKERS" \
  --output_dir="$OUTPUT" \
  --job_name=smolvla_handover \
  --wandb.enable=false \
  "$@"
