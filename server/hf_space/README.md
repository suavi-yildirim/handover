---
title: Handover episode upload
emoji: 🤖
colorFrom: pink
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
short_description: Receives Handover play episodes for the open dataset
---

# Handover episode upload

Receives episodes from the Handover game and saves them to a Hugging Face dataset.
Players turn sharing on once in the game; after that each finished episode is sent here.

- `POST /episodes`: body is a gzipped JSON Lines file of episodes (the game's export format).
  Answers `{"saved": n, "duplicates": m}`, or an error with a reason in `detail`.
- `GET /`: health check, says whether pushing to the dataset is configured.

Every episode is checked (format, CC-BY-4.0 license, ids, frame arrays) before anything is
saved. Saved episodes are pushed to the dataset every 5 minutes, under
`raw/game-<version>/<date>/<episode_id>.jsonl.gz`. IP addresses are never written to disk.

Setup steps and the privacy notes are in `docs/upload.md` of the Handover repository.
