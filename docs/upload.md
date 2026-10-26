# Sharing episodes

Players can share their episodes with the project's dataset automatically. They turn
sharing on once; after that each finished episode is sent in the background to a free
Cloudflare Worker, which checks it and commits it to a private Hugging Face dataset. No
login is needed, and the Hugging Face token lives only in the Worker's secrets, never in the game.

```
game (browser) --POST /episodes--> Worker (server/cf_worker) --commit API--> HF dataset (private)
```

## What the player sees

1. "Share my episodes" in the side menu (M). Until `UPLOAD_URL` is set it reads "Sharing isn't set up yet".
2. A consent dialog lists what an episode holds, says episodes are published under CC-BY-4.0,
   explains the IP address handling, and shows the player's contributor ID for removal requests.
   Nothing is sent until the box is ticked and "Turn on sharing" is clicked.
3. Turning it on also sends the episodes already played in that window. After that, every
   finished episode (successful or not) is sent as it ends. The choice is remembered per browser.
4. A short note confirms each upload. If one fails (offline, rate limit, server error), the
   episode stays queued and goes with the next one; after 3 failed tries it is given up.
   Files the server refuses are not retried.
5. Clicking "Sharing on · click to stop" turns it off at once. "Not now" in the dialog sends nothing.
   Download still works in every case.

## Setup (once, by the project owner, on the Mac)

Everything here is free and needs no payment card.

1. **Hugging Face:** create a **private dataset** repo `suavi-yildirim/handover-episodes`, then a
   **fine-grained access token** (Settings → Access Tokens) with write access to that dataset only.
2. **Cloudflare:** create a free account at dash.cloudflare.com.
3. **Deploy** from the repo:
   ```sh
   cd server/cf_worker
   npx wrangler login              # opens the browser to sign in to Cloudflare
   npx wrangler secret put HF_TOKEN   # paste the token here, at the prompt only
   npx wrangler deploy
   ```
   `deploy` prints the address, e.g. `https://handover-upload.<account>.workers.dev`.
   Opening it should show `{"ok":true,"pushing_to_dataset":true}`.
4. **Game:** set `UPLOAD_URL` in `web/src/upload.js` to `<that address>/episodes`, run
   `tools/build_docs.sh` so the GitHub Pages copy gets it too, and commit.

`wrangler.toml` sets `DATASET_REPO` and `ALLOWED_ORIGINS` (GitHub Pages and the local server).
If the game is served from somewhere else, add that origin there and deploy again.

## Limits and trade-offs

- **Cost:** $0. The free Workers plan allows 100,000 requests a day.
- **CPU:** the free plan allows about 10 ms of CPU per request. A 15 s episode takes about 4 ms
  (measured in Node; Cloudflare's runtime does gunzip natively and should be faster), so the
  game sends one episode per request. Episodes much longer than a minute may exceed the limit;
  the game gives up on them after 3 tries and the player still has Download.
- **Commits:** each upload is one commit to the dataset. The Hub limits how fast a repo can take
  commits; at today's player numbers that is far away, but many players at once would need batching.
- **Rate limit:** 120 uploads per address per hour, at most 3 episodes and 2 MB per upload. The
  count lives in each Worker instance's memory, so it is best effort; a Cloudflare rate-limiting
  rule in the dashboard can back it up.
- **Spam:** anyone who finds the address can post files. Each file must pass the format checks
  (Handover episode, CC-BY-4.0, UUID ids, numeric frame arrays of one width), but a valid-looking
  fake episode could get through. Review data before publishing, and filter by `game_version`.

## Privacy (GDPR)

- Sharing is opt-in, with the purpose, the license and the removal route stated before anything is sent.
- An episode holds simulated robot states, steering inputs, task results, the input device
  names, the game version and a random contributor ID stored in the browser. No camera, audio,
  name, email or account.
- The Worker sees the player's IP address while a request runs. It keeps addresses in memory for
  the rate limit only, forgets them after an hour, and never writes them to the dataset or to logs
  (`observability` is off in `wrangler.toml`). Cloudflare's own infrastructure handles the
  connection under its privacy policy.
- Dataset layout: `raw/game-<version>/<episode_id>.jsonl`, one episode per file, unchanged from
  what the game recorded.
- Removal: a player quotes their contributor ID; delete their files from the dataset. Keeping
  the dataset private until a reviewed release keeps this possible.

## Tests

- `node tests/upload.mjs`: the game's upload client and opt-in/queue logic, against a mock server.
- `node server/cf_worker/test.mjs`: the Worker's checks on the real fixture episodes, refusals,
  size caps, CORS, the rate limit, the commit payload, and that no IP address reaches the dataset.
  No network or account needed: the Hub is mocked.
- `npx wrangler dev` in `server/cf_worker` runs the Worker locally in Cloudflare's runtime; point
  `HF_ENDPOINT` at a mock Hub (`--var HF_ENDPOINT:http://127.0.0.1:7870`) to try it end to end
  without touching the real dataset.
