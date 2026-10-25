# Sharing episodes

Players can share their episodes with the project's dataset automatically. They turn
sharing on once; after that each finished episode is sent in the background to a free
Hugging Face Space, which checks it and saves it to a Hugging Face dataset. No login is
needed, and the upload token lives only in the Space's secrets, never in the game.

```
game (browser) --POST /episodes--> Space (server/hf_space) --every 5 min--> dataset repo (private)
```

## What the player sees

1. "Share my episodes" in the side menu (M). Until `UPLOAD_URL` is set it reads "Sharing isn't set up yet".
2. A consent dialog lists what an episode holds, says episodes are published under CC-BY-4.0,
   explains the IP address handling, and shows the player's contributor ID for removal requests.
   Nothing is sent until the box is ticked and "Turn on sharing" is clicked.
3. Turning it on also sends the episodes already played in that window. After that, every
   finished episode (successful or not) is sent as it ends. The choice is remembered per browser.
4. A short note confirms each upload. If one fails (offline, Space asleep, rate limit), the
   episode stays queued and goes with the next one. Files the server refuses are not retried.
5. Clicking "Sharing on · click to stop" turns it off at once. "Not now" in the dialog sends nothing.
   Download still works in every case.

## Setup (once, by the project owner)

Everything here is free. Steps for the Hugging Face website:

1. Create a free account at huggingface.co.
2. Create a **dataset** repo, e.g. `<you>/handover-episodes`, and keep it **private** until you
   publish a reviewed release. (The Space creates it private if it doesn't exist.)
3. Create a **fine-grained access token** (Settings → Access Tokens) with write access to that
   dataset only. Don't paste it anywhere except step 5.
4. Create a new **Space**, SDK "Docker", hardware "CPU basic" (free). Upload the four files from
   `server/hf_space/` (`README.md`, `Dockerfile`, `requirements.txt`, `app.py`).
5. In the Space's Settings → Variables and secrets, add:
   - secret `HF_TOKEN`: the token from step 3
   - variable `DATASET_REPO`: the repo from step 2
   - variable `ALLOWED_ORIGINS` (optional): where the game is served from, e.g.
     `http://localhost:8000`; the default `*` allows any page
6. When the Space shows "Running", opening its address should show
   `{"ok":true,"pushing_to_dataset":true}`.
7. Set `UPLOAD_URL` in `web/src/upload.js` to `https://<space-address>.hf.space/episodes` and reload the game.

## Limits and trade-offs

- **Cost:** $0 on the free CPU Space and a free dataset repo.
- **Sleep:** a free Space sleeps after a while without visits. The first upload then takes
  about 30 s while it wakes; the game waits up to 90 s and otherwise retries with the next episode.
- **Ephemeral disk:** episodes wait up to 5 minutes on the Space before being pushed. If the
  Space restarts in that window, those episodes are lost (the player still has Download).
- **Rate limit:** 120 uploads per address per hour, at most 50 episodes and 8 MB per upload.
- **Spam:** anyone who finds the address can post files. Each file must pass the format checks
  (Handover episode, CC-BY-4.0, UUID ids, numeric frame arrays of one width), but a valid-looking
  fake episode could get through. Review data before publishing, and filter by `game_version`.

## Privacy (GDPR)

- Sharing is opt-in, with the purpose, the license and the removal route stated before anything is sent.
- An episode holds simulated robot states, steering inputs, task results, the input device
  names, the game version and a random contributor ID stored in the browser. No camera, audio,
  name, email or account.
- The Space sees the player's IP address while a request runs. It keeps addresses in memory for
  the rate limit only, forgets them after an hour, and never writes them to disk or the dataset.
  Hugging Face's own infrastructure may log requests under its privacy policy.
- Removal: a player quotes their contributor ID; delete their files from the dataset. Keeping
  the dataset private until release keeps this possible.

## Tests

- `node tests/upload.mjs`: the upload client and the opt-in/queue logic, against a mock server.
- `python server/hf_space/test_app.py` (needs `pip install -r server/hf_space/requirements.txt httpx`):
  the Space's checks on the real fixture episodes, refusals, size caps, CORS, the rate limit,
  and that no IP address reaches disk.
