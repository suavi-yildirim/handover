# Sending episodes

"Send my episodes" lets a player share recorded episodes with the project. It costs nothing
and needs no server: the game downloads the episode file, then opens a new GitHub issue on
`suavi-yildirim/handover` with the file to drag into it.

## What the player sees

1. The button appears under the episode count in the side menu (M) once at least one episode exists.
2. A consent dialog lists what the file holds, says it is released under CC-BY-4.0, and says that
   sending is public and permanent on GitHub. Nothing happens until the box is ticked.
3. "Download and open issue" downloads the file and opens a prefilled issue. The player drags the
   file in and submits. Nothing is public until they submit.
4. "Not now" closes the dialog and sends nothing. The episodes stay in the browser, and Download still works.

If the browser blocks the new tab, the dialog shows a direct link instead.

## Options considered

| Option | Cost | Trade-offs | Verdict |
|---|---|---|---|
| GitHub issue with the file attached (chosen) | $0 | Public and permanent; the player needs a GitHub account; no server to run | Used |
| Cloudflare Worker + R2 bucket | Free tier, but needs an account and a deployed endpoint | Private storage the project controls; logs IP addresses; needs CORS and a size cap | Not now: needs an account and a deploy |
| Google Form with a file-upload field | $0 | Needs a Google account; files land in the owner's Drive | Not chosen: data leaves the project's repo, and sign-in is required |
| Commit the file to the repo | $0 | Public, permanent, and bloats git history | Rejected |

## Privacy

The file holds simulated joint states, steering inputs, task results, the game version, and a
random contributor ID stored in the browser. It holds no camera images, audio, or account data.
GitHub sees the player's IP address and keeps the issue and its history.

## Changing the destination

`ISSUE_REPO` in `web/src/upload.js` sets the repo that receives issues. The consent text in
`web/index.html` names GitHub and must be updated if the destination changes.

## Tests

`node tests/upload.mjs` checks the issue link, the blocked-tab fallback, and the gzipped file.
The consent flow was smoke-tested in Chromium.
